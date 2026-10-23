// assistant-chat: the owner's finance assistant. The model reads and proposes; code validates, builds the cards,
// executes only after an explicit confirm and keeps the undo data. Pure TS with injected db clients, fetch and clock.
import { callMessages, textOf, type ChatMessage, type TextBlock, type ToolResultBlock } from './anthropic.ts'
import { executeAll, runUndo } from './assistant-exec.ts'
import { ASSISTANT_PERSONA } from './assistant-prompt.ts'
import { lostClaim, pendingViewOf } from './assistant-state.ts'
import { TOOL_DEFS, executeTool, newRun, type ToolCtx, type ToolRun } from './assistant-tools.ts'
import type {
  AssistantResponse, Card, ChoiceCard, MessageView, PendingActionItem, PendingView, ProposalCard, UndoItem,
} from './assistant-types.ts'
import { GUARD_FALLBACK, GUARD_NOTE, validatePick, violatesTextGuard } from './assistant-validate.ts'
import { callRpc, unwrap } from './db.ts'
import { isUuid } from './gates.ts'
import { isoOf, spParts, weekdayName } from './time.ts'
import type { Db, FetchFn } from './types.ts'

export const MAX_TOOL_ITERATIONS = 6
export const RUN_BUDGET_MS = 40_000
export const RATE_LIMIT = 30
export const RATE_WINDOW_MS = 10 * 60_000
const HISTORY = 12

export interface AssistantRuntime {
  /** Service client: assistant tables only. */
  svc: Db
  /** Verifies the user JWT (auth.getUser). Null when invalid. */
  authenticate(jwt: string): Promise<{ id: string } | null>
  /** Client scoped to the owner JWT: finance RPCs run with it, so their owner checks apply. */
  userDb(jwt: string): Db
  fetch: FetchFn
  now: () => number
  uuid: () => string
  cfg: { anthropicKey?: string; model: string }
  log: (event: string, data?: Record<string, unknown>) => void
}

export interface AssistantReply {
  status: number
  body: AssistantResponse | { error: string }
}

interface Row {
  id: string
  role: 'user' | 'assistant' | 'card'
  body: string | null
  card: Card | null
  meta: Record<string, any> | null
  created_at: string
}
const COLS = 'id,role,body,card,meta,created_at'
const err = (status: number, error: string): AssistantReply => ({ status, body: { error } })

interface Turn {
  rt: AssistantRuntime
  uid: string
  userDb: Db
  requestId: string
  out: Row[]
  touched: Set<string>
  firstMeta: Record<string, unknown> | null
}

async function add(t: Turn, role: Row['role'], body: string | null, card: Card | null = null, meta: Record<string, unknown> = {}): Promise<Row> {
  const extra = role !== 'user' && t.firstMeta ? t.firstMeta : {}
  if (role !== 'user') t.firstMeta = null
  const row = unwrap<Row>(
    await t.rt.svc.from('assistant_messages').insert({ owner_user_id: t.uid, role, body, card, meta: { request_id: t.requestId, ...extra, ...meta } }).select(COLS).single(),
  )
  t.out.push(row)
  return row
}

const viewOf = (r: Row): MessageView => ({ id: r.id, role: r.role, body: r.body, card: r.card, created_at: r.created_at })

// ---------------------------------------------------------------- pending rows
interface PendingRow {
  id: string
  owner_user_id: string
  actions: PendingActionItem[]
  status: PendingView['status']
  expires_at: string
  executed_at: string | null
  result: { lines: Array<{ index: number; ok: boolean; text: string }> } | null
  undo: UndoItem[] | null
  created_at: string
}

async function loadPending(t: Turn, id: string): Promise<PendingRow | null> {
  return unwrap<PendingRow | null>(await t.rt.svc.from('assistant_pending').select('*').eq('id', id).eq('owner_user_id', t.uid).maybeSingle())
}

async function respond(t: Turn): Promise<AssistantReply> {
  const pendings: PendingView[] = []
  for (const id of t.touched) {
    const p = await loadPending(t, id)
    if (p) pendings.push(pendingViewOf(p))
  }
  return { status: 200, body: { messages: t.out.filter((r) => !r.meta?.hidden).map(viewOf), pendings } }
}

// ---------------------------------------------------------------- entry point
export async function handleAssistant(rt: AssistantRuntime, jwt: string | null, raw: unknown): Promise<AssistantReply> {
  if (!jwt) return err(401, 'Faça login de novo para usar o assistente.')
  let user: { id: string } | null = null
  try {
    user = await rt.authenticate(jwt)
  } catch {
    user = null
  }
  if (!user) return err(401, 'Sessão inválida. Faça login de novo.')
  const userDb = rt.userDb(jwt)
  let owner = false
  try {
    owner = (await callRpc<boolean>(userDb, 'is_owner')) === true
  } catch {
    owner = false
  }
  if (!owner) return err(403, 'O assistente é exclusivo da dona do studio.')

  const enabled = unwrap<Array<{ value: unknown }>>(await rt.svc.from('studio_settings').select('value').eq('key', 'assistant_enabled'))
  if (enabled?.[0] && (enabled[0].value === false || enabled[0].value === 'false')) return err(503, 'O assistente está desativado no momento.')

  const body = raw as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return err(400, 'Requisição inválida.')
  const action = body.action
  if (action !== 'message' && action !== 'confirm' && action !== 'cancel' && action !== 'undo') return err(400, 'Ação inválida.')
  if (action === 'message') {
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 1000) return err(400, 'Escreva uma mensagem de até 1000 caracteres.')
    const pk = body.pick
    if (pk !== undefined && (typeof pk !== 'object' || pk === null || typeof (pk as any).choice_id !== 'string' || typeof (pk as any).value !== 'string')) return err(400, 'Escolha inválida.')
  } else {
    if (!isUuid(body.pending_id)) return err(400, 'Proposta inválida.')
    if (action === 'undo' && body.action_index !== undefined && !(Number.isInteger(body.action_index) && (body.action_index as number) >= 0 && (body.action_index as number) < 10)) return err(400, 'Ação inválida.')
  }
  const requestId = isUuid(body.request_id) ? (body.request_id as string).toLowerCase() : rt.uuid()
  const t: Turn = { rt, uid: user.id, userDb, requestId, out: [], touched: new Set(), firstMeta: null }

  // Same request id again (double tap, retry): return what the first one produced, run nothing.
  const prior = unwrap<Row[]>(await rt.svc.from('assistant_messages').select(COLS).eq('owner_user_id', user.id).eq('meta->>request_id', requestId).order('created_at', { ascending: true }))
  if (prior?.length) {
    t.out = prior
    for (const r of prior) if (r.card && 'pending_id' in r.card) t.touched.add((r.card as ProposalCard).pending_id)
    return await respond(t)
  }

  const since = isoOf(rt.now() - RATE_WINDOW_MS)
  const limited = await rt.svc.from('assistant_messages').select('id', { count: 'exact', head: true }).eq('owner_user_id', user.id).eq('role', 'user').gte('created_at', since)
  if (limited.error) throw new Error(limited.error.message)
  if ((limited.count ?? 0) >= RATE_LIMIT) return err(429, 'Muitas mensagens em pouco tempo. Aguarde alguns minutos e tente de novo.')

  try {
    if (action === 'message') await onMessage(t, (body.text as string).trim(), body.pick as { choice_id: string; value: string } | undefined)
    else if (action === 'confirm') await onConfirm(t, body.pending_id as string)
    else if (action === 'cancel') await onCancel(t, body.pending_id as string)
    else await onUndo(t, body.pending_id as string, body.action_index as number | undefined)
  } catch (e) {
    rt.log('assistant_failed', { action, error: String(e instanceof Error ? e.message : e) })
    await add(t, 'assistant', 'Algo deu errado do meu lado. Confira o lançamento antes de tentar de novo.', null, { error: true })
  }
  return await respond(t)
}

// ---------------------------------------------------------------- message turn
async function loadKnown(t: Turn): Promise<Set<string>> {
  const rows = unwrap<Array<{ meta: { known_ids?: string[] } | null }>>(
    await t.rt.svc.from('assistant_messages').select('meta').eq('owner_user_id', t.uid).in('role', ['assistant', 'card']).order('created_at', { ascending: false }).limit(HISTORY),
  )
  const known = new Set<string>()
  for (const r of rows ?? []) for (const id of r.meta?.known_ids ?? []) if (isUuid(id)) known.add(id)
  return known
}

async function onMessage(t: Turn, text: string, pick?: { choice_id: string; value: string }): Promise<void> {
  if (pick) return await onPick(t, text, pick)
  await add(t, 'user', text, null, {})
  const known = await loadKnown(t)
  await runModel(t, newRun(known))
}

async function onPick(t: Turn, text: string, pick: { choice_id: string; value: string }): Promise<void> {
  const rows = unwrap<Row[]>(await t.rt.svc.from('assistant_messages').select(COLS).eq('owner_user_id', t.uid).eq('role', 'card').order('created_at', { ascending: false }).limit(10))
  const row = (rows ?? []).find((r) => r.card?.kind === 'choice' && (r.card as ChoiceCard).choice_id === pick.choice_id)
  const card = row?.card?.kind === 'choice' ? (row.card as ChoiceCard) : null
  const latestChoice = (rows ?? []).find((r) => r.card?.kind === 'choice')
  // Only the most recent choice card can still be picked from.
  const check = validatePick(latestChoice?.id === row?.id ? card : null, !!row?.meta?.resolved, pick.choice_id, pick.value)
  if (!check.ok) {
    await add(t, 'user', text.slice(0, 200), null, {})
    await add(t, 'assistant', check.message)
    return
  }
  await add(t, 'user', check.value.label, null, { kind: 'pick' })
  unwrap(await t.rt.svc.from('assistant_messages').update({ meta: { ...(row!.meta ?? {}), resolved: true } }).eq('id', row!.id))
  const run = newRun([...(await loadKnown(t)), ...card!.options.map((o) => o.value)])
  run.proposals = [...card!.intent.carry]
  run.picks[card!.slot] = pick.value
  const ctx = toolCtx(t, run)
  const input = card!.slot === 'client_id' ? card!.intent.input : { ...card!.intent.input, [card!.slot]: pick.value } // the owner's pick replaces the model's id
  const out = await executeTool(ctx, card!.intent.tool, input)
  if (!out.ok && out.code !== 'NEEDS_CHOICE') {
    run.firstError = out.message
    run.proposals = [] // a failed pick leaves nothing half-proposed
  }
  await finish(t, run, run.firstError ? `Não consegui montar a ação: ${run.firstError}` : '', 'none', null, true)
}

const toolCtx = (t: Turn, run: ToolRun): ToolCtx => ({ userDb: t.userDb, now: t.rt.now, uuid: t.rt.uuid, run })

const SPOKEN = (nowMs: number) => {
  const p = spParts(nowMs)
  return `Hoje é ${weekdayName(p.weekday)}, ${p.ymd} (fuso America/Sao_Paulo).`
}

async function history(t: Turn): Promise<ChatMessage[]> {
  const rows = unwrap<Row[]>(
    await t.rt.svc.from('assistant_messages').select(COLS).eq('owner_user_id', t.uid).in('role', ['user', 'assistant']).not('body', 'is', null).order('created_at', { ascending: false }).limit(HISTORY),
  )
  const msgs: ChatMessage[] = []
  for (const r of (rows ?? []).slice().reverse()) {
    const role = r.role === 'user' ? 'user' : 'assistant'
    const last = msgs[msgs.length - 1]
    if (last && last.role === role) last.content = `${last.content as string}\n${r.body}`
    else msgs.push({ role, content: r.body! })
  }
  while (msgs.length && msgs[0]!.role !== 'user') msgs.shift()
  return msgs
}

interface Usage {
  input: number
  output: number
}

async function runModel(t: Turn, run: ToolRun): Promise<void> {
  const { rt } = t
  const system: TextBlock[] = [
    { type: 'text', text: ASSISTANT_PERSONA, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: SPOKEN(rt.now()) },
  ]
  const messages = await history(t)
  const ctx = toolCtx(t, run)
  const started = rt.now()
  const usage: Usage = { input: 0, output: 0 }
  const call = async (extra: Record<string, unknown> = {}) => {
    const left = RUN_BUDGET_MS - (rt.now() - started)
    if (left <= 0) throw new Error('assistant budget exceeded')
    const res = await callMessages(rt.fetch, rt.cfg.anthropicKey, { model: rt.cfg.model, max_tokens: 600, temperature: 0.2, system, messages, tools: TOOL_DEFS, ...extra } as any, left)
    usage.input += (res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0) + (res.usage?.cache_creation_input_tokens ?? 0)
    usage.output += res.usage?.output_tokens ?? 0
    return res
  }

  let text = ''
  let guard: 'none' | 'regenerated' | 'fallback' = 'none'
  try {
    let settled = false
    for (let i = 0; i < MAX_TOOL_ITERATIONS && !settled; i++) {
      const res = await call()
      const uses = res.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
      if (res.stop_reason === 'tool_use' && uses.length) {
        messages.push({ role: 'assistant', content: res.content })
        const results: ToolResultBlock[] = []
        for (const u of uses) {
          // Once a tool asked the owner something (choice or question), nothing else in the batch runs.
          const out = run.choice || run.question ? { ok: false as const, code: 'SKIPPED', message: 'Aguardando a resposta do usuário.' } : await executeTool(ctx, u.name, u.input)
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out.ok ? {} : { is_error: true }) })
        }
        messages.push({ role: 'user', content: results })
        if (run.choice || run.question) return await finish(t, run, '', guard, usage)
      } else {
        text = textOf(res)
        settled = true
      }
    }
    if (!settled) text = textOf(await call({ tool_choice: { type: 'none' } })) // closing call: tools disabled

    if (violatesTextGuard(text)) {
      guard = 'regenerated'
      text = textOf(await call({ system: [...system, { type: 'text', text: GUARD_NOTE }], tool_choice: { type: 'none' } }))
      if (violatesTextGuard(text)) {
        guard = 'fallback'
        text = GUARD_FALLBACK
        run.proposals = [] // nothing is proposed behind a reply the guard rejected
        run.readCards = []
      }
    }
  } catch (e) {
    rt.log('assistant_model_failed', { error: String(e instanceof Error ? e.message : e) })
    run.proposals = []
    run.readCards = []
    await finish(t, run, 'Não consegui falar com o assistente agora. Tente de novo em instantes.', 'none', usage)
    return
  }
  await finish(t, run, text, guard, usage)
}

// ---------------------------------------------------------------- output of a turn
async function finish(t: Turn, run: ToolRun, text: string, guard: string, usage: Usage | null, fromPick = false): Promise<void> {
  t.firstMeta = { tools: run.toolLog, known_ids: [...run.known].slice(0, 200), guard, ...(usage ? { usage } : {}), ...(fromPick ? { from_pick: true } : {}) }
  if (run.choice) {
    await add(t, 'card', null, run.choice)
    return
  }
  if (run.question) {
    await add(t, 'card', null, run.question)
    return
  }
  const lead = text.trim()
  if (lead) await add(t, 'assistant', lead)
  if (run.proposals.length) {
    const actions = run.proposals.slice(0, 10)
    const p = unwrap<PendingRow>(
      await t.rt.svc.from('assistant_pending').insert({
        owner_user_id: t.uid,
        actions,
      }).select('*').single(),
    )
    t.touched.add(p.id)
    const card: ProposalCard = { kind: 'proposal', pending_id: p.id, expires_at: p.expires_at, actions: actions.map((a) => a.summary) }
    await add(t, 'card', null, card)
    return
  }
  for (const c of run.readCards.slice(-3)) await add(t, 'card', null, c)
  if (!t.out.some((r) => r.role !== 'user')) await add(t, 'assistant', 'Não entendi bem. Pode reformular?')
}

// ---------------------------------------------------------------- confirm / cancel / undo
const hiddenMarker = (t: Turn, kind: string) => add(t, 'user', null, null, { hidden: true, kind })

async function onConfirm(t: Turn, pendingId: string): Promise<void> {
  await hiddenMarker(t, 'confirm')
  t.touched.add(pendingId)
  const now = isoOf(t.rt.now())
  // One atomic UPDATE decides who executes: pending -> confirmed only while it has not expired.
  const claimed = unwrap<PendingRow[]>(
    await t.rt.svc.from('assistant_pending').update({ status: 'confirmed' }).eq('id', pendingId).eq('owner_user_id', t.uid).eq('status', 'pending').gt('expires_at', now).select('*'),
  )
  if (!claimed?.length) {
    const p = await loadPending(t, pendingId)
    const why = lostClaim(p)
    if (why === 'missing') return void (await add(t, 'assistant', 'Essa proposta não existe mais.'))
    if (why === 'replay') {
      // Already executed: show the stored result again, execute nothing.
      const rows = unwrap<Row[]>(await t.rt.svc.from('assistant_messages').select(COLS).eq('owner_user_id', t.uid).eq('role', 'card').eq('card->>pending_id', pendingId).eq('card->>kind', 'result'))
      if (rows?.length) t.out.push(rows[0]!)
      else await add(t, 'assistant', 'Essa proposta já foi confirmada.')
      return
    }
    if (why === 'expire_now') unwrap(await t.rt.svc.from('assistant_pending').update({ status: 'expired' }).eq('id', pendingId).eq('status', 'pending'))
    return void (await add(t, 'assistant', why === 'cancelled' ? 'Essa proposta foi cancelada.' : 'Essa proposta expirou e foi descartada. Peça de novo se ainda quiser.'))
  }
  const row = claimed[0]!
  const summary = await executeAll(t.userDb, row.id, row.actions)
  unwrap(
    await t.rt.svc.from('assistant_pending').update({ status: summary.status, executed_at: isoOf(t.rt.now()), result: { lines: summary.lines }, undo: summary.undo }).eq('id', row.id),
  )
  await add(t, 'assistant', summary.reply, null, { code_built: true })
  await add(t, 'card', null, { kind: 'result', pending_id: row.id, lines: summary.lines })
}

async function onCancel(t: Turn, pendingId: string): Promise<void> {
  await hiddenMarker(t, 'cancel')
  t.touched.add(pendingId)
  const claimed = unwrap<PendingRow[]>(
    await t.rt.svc.from('assistant_pending').update({ status: 'cancelled' }).eq('id', pendingId).eq('owner_user_id', t.uid).eq('status', 'pending').select('*'),
  )
  if (claimed?.length) return void (await add(t, 'assistant', 'Proposta cancelada. Nada foi alterado.', null, { code_built: true }))
  const p = await loadPending(t, pendingId)
  if (!p) return void (await add(t, 'assistant', 'Essa proposta não existe mais.'))
  await add(t, 'assistant', p.status === 'cancelled' ? 'Essa proposta já tinha sido cancelada.' : p.status === 'expired' ? 'Essa proposta já tinha expirado.' : 'Essa proposta já foi confirmada; use Desfazer se precisar reverter.')
}

async function onUndo(t: Turn, pendingId: string, index?: number): Promise<void> {
  await hiddenMarker(t, 'undo')
  t.touched.add(pendingId)
  const p = await loadPending(t, pendingId)
  if (!p || (p.status !== 'confirmed' && p.status !== 'failed')) return void (await add(t, 'assistant', 'Não há nada para desfazer aqui.'))
  const items = (p.undo ?? []).filter((u) => !u.done && (index === undefined || u.index === index))
  if (!items.length) return void (await add(t, 'assistant', 'Não há nada para desfazer aqui.'))
  const undo = [...(p.undo ?? [])]
  const done: string[] = []
  let blocked: string | null = null
  for (const item of items.slice().reverse()) {
    const r = await runUndo(t.userDb, item)
    if (!r.ok) {
      blocked = r.message
      break
    }
    done.push(item.label)
    undo[undo.findIndex((u) => u.index === item.index)] = { ...item, done: true }
  }
  if (done.length) unwrap(await t.rt.svc.from('assistant_pending').update({ undo }).eq('id', p.id))
  await add(
    t, 'assistant',
    [done.length ? `Desfeito: ${done.join('; ')}.` : '', blocked ? `Não deu para desfazer: ${blocked}` : ''].filter(Boolean).join(' '),
    null, { code_built: true },
  )
}
