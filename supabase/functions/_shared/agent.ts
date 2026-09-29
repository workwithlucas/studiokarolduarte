// agent-run: one guarded turn of Thaís for a conversation.
// The model proposes; every write it asks for passes a code gate (tools.ts / gates.ts).
import { callMessages, textOf, type ChatMessage, type MessagesRequest, type TextBlock, type ToolResultBlock } from './anthropic.ts'
import { buildDynamicBlock, buildMessages } from './context.ts'
import { callRpc, getConversation, latestInbound, loadSettings, modeAllows, recentMessages, storeOutbound, updateConversation } from './db.ts'
import { dropForbiddenSentences, formatReply, hasForbiddenPhrase } from './filters.ts'
import { awayDue } from './gates.ts'
import { KB } from './kb.ts'
import { PERSONA } from './prompt.ts'
import { executeTool, TOOL_DEFS, type ToolCtx } from './tools.ts'
import { inWindow, isoOf, tsKey } from './time.ts'
import type { Deps } from './types.ts'
import { sendText } from './zapi.ts'

export const MAX_ITERATIONS = 6
export const RUN_BUDGET_MS = 60_000
export const HANDOFF_TEXT = 'Vou pedir para a Karol falar com você por aqui, tá bem?'

export interface RunOutcome {
  status: 'sent' | 'not_claimed' | 'skipped' | 'away' | 'discarded' | 'handoff' | 'silent' | 'blocked' | 'failed'
  reason?: string
  sent?: string[]
  usage?: { input: number; output: number }
}

const CORRECTION = `CORREÇÃO OBRIGATÓRIA: sua resposta anterior continha uma frase proibida (dizer que você não consegue ver, abrir, ler, ouvir ou interpretar imagens, figurinhas ou áudios, ou pedir para "mandar por texto"). Reescreva a resposta sem essa frase. Responda ao conteúdo da mensagem normalmente e nunca fale de limitações de mídia.`

export async function runAgent(deps: Deps, conversationId: string): Promise<RunOutcome> {
  const claimed = await callRpc<boolean>(deps.db, 'agent_claim', { p_conversation_id: conversationId, p_lease_seconds: 90 })
  if (!claimed) return { status: 'not_claimed' }
  try {
    return await runClaimed(deps, conversationId)
  } catch (e) {
    deps.log('agent_run_failed', { conversation: conversationId, error: String(e instanceof Error ? e.message : e) })
    try {
      const c = await getConversation(deps.db, conversationId)
      if (c) await updateConversation(deps.db, conversationId, { failed_runs: c.failed_runs + 1 })
    } catch (e2) {
      deps.log('failed_runs_update_failed', { error: String(e2 instanceof Error ? e2.message : e2) })
    }
    return { status: 'failed' } // never a message to the client
  } finally {
    try {
      await callRpc(deps.db, 'agent_release', { p_conversation_id: conversationId })
    } catch (e) {
      deps.log('release_failed', { error: String(e instanceof Error ? e.message : e) })
    }
  }
}

async function runClaimed(deps: Deps, id: string): Promise<RunOutcome> {
  const { db } = deps
  const settings = await loadSettings(db)
  const conv = await getConversation(db, id)
  if (!conv) return { status: 'skipped', reason: 'no_conversation' }
  if (!modeAllows(settings, conv.phone_e164)) return { status: 'skipped', reason: 'mode' }
  if (conv.mode === 'human') return { status: 'skipped', reason: 'human' }
  if (!conv.pending_since) return { status: 'skipped', reason: 'nothing_pending' }

  // Outside the window: no LLM call. The away message goes out once per 12h; messages stay pending.
  if (!inWindow(deps.now(), settings.agent_window_start, settings.agent_window_end)) {
    if (!awayDue(conv.away_sent_at, deps.now())) return { status: 'skipped', reason: 'outside_window' }
    const r = await sendText(deps.fetch, deps.cfg.zapi, conv.phone_e164, settings.agent_away_message)
    await storeOutbound(db, id, r.messageId, settings.agent_away_message, 'away')
    await updateConversation(db, id, { away_sent_at: isoOf(deps.now()), last_outbound_at: isoOf(deps.now()) })
    return { status: 'away', sent: [settings.agent_away_message] }
  }

  // Two audios in a row that could not be transcribed: hand over, no LLM call.
  if (conv.audio_failures >= 2) {
    await callRpc(db, 'agent_flag', { p_conversation_id: id, p_reason: 'Mensagens de voz sem transcrição', p_handoff: true, p_handoff_hours: 12 })
    const r = await sendText(deps.fetch, deps.cfg.zapi, conv.phone_e164, HANDOFF_TEXT)
    await storeOutbound(db, id, r.messageId, HANDOFF_TEXT, 'handoff')
    await updateConversation(db, id, { pending_since: null, last_outbound_at: isoOf(deps.now()) })
    return { status: 'handoff', reason: 'audio', sent: [HANDOFF_TEXT] }
  }

  const history = await recentMessages(db, id, settings.history_messages)
  const lastIn = [...history].reverse().find((m) => m.direction === 'in')
  if (!lastIn) return { status: 'skipped', reason: 'no_inbound' }
  const messages: ChatMessage[] = buildMessages(history)
  if (!messages.length || messages[messages.length - 1]!.role !== 'user') return { status: 'skipped', reason: 'no_user_turn' }

  const ctx: ToolCtx = { deps, conv, settings, snapshotLastInboundAt: lastIn.created_at, flags: { handoff: false, noted: false, booked: false } }
  const system: TextBlock[] = [
    { type: 'text', text: `${PERSONA}\n\n${KB}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: await buildDynamicBlock(ctx) },
  ]

  const started = deps.now()
  const usage = { input: 0, output: 0 }
  const call = async (req: Partial<MessagesRequest>) => {
    const left = RUN_BUDGET_MS - (deps.now() - started)
    if (left <= 0) throw new Error('run budget exceeded')
    const res = await callMessages(deps.fetch, deps.cfg.anthropicKey, { model: deps.cfg.model, max_tokens: 500, temperature: 0.3, system, messages, tools: TOOL_DEFS, ...req }, left)
    usage.input += (res.usage?.input_tokens ?? 0) + (res.usage?.cache_read_input_tokens ?? 0) + (res.usage?.cache_creation_input_tokens ?? 0)
    usage.output += res.usage?.output_tokens ?? 0
    return res
  }

  // At most MAX_ITERATIONS rounds of tool use; after the last round one closing call (tools disabled) must
  // produce the text. Still asking for tools there means the run is broken.
  let text: string | null = null
  for (let i = 0; i <= MAX_ITERATIONS && text === null; i++) {
    const closing = i === MAX_ITERATIONS
    const res = await call(closing ? { tool_choice: { type: 'none' } } : {})
    const uses = res.content.filter((b): b is Extract<typeof b, { type: 'tool_use' }> => b.type === 'tool_use')
    if (closing && uses.length) break // still asking for tools after the limit: text stays null -> run fails
    if (res.stop_reason === 'tool_use' && uses.length) {
      messages.push({ role: 'assistant', content: res.content })
      const results: ToolResultBlock[] = []
      for (const u of uses) {
        const out = await executeTool(ctx, u.name, u.input)
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out), ...(out.ok === false ? { is_error: true } : {}) })
      }
      messages.push({ role: 'user', content: results })
    } else {
      text = textOf(res)
    }
  }
  if (text === null) throw new Error('tool loop exceeded the iteration limit')

  // Forbidden phrases: regenerate once with a corrective note, then drop what still matches.
  let blocked = false
  if (hasForbiddenPhrase(text)) {
    const retry = await call({ system: [...system, { type: 'text', text: CORRECTION }], tool_choice: { type: 'none' } })
    text = textOf(retry)
    if (hasForbiddenPhrase(text)) {
      text = dropForbiddenSentences(text)
      blocked = text === ''
    }
  }
  const parts = formatReply(text)

  // A newer inbound arrived while we worked: discard, the newer run answers.
  const newest = await latestInbound(db, id)
  if (newest && (tsKey(newest.created_at) ?? 0) > (tsKey(lastIn.created_at) ?? 0)) return { status: 'discarded', usage }

  if (parts.length === 0) {
    await updateConversation(db, id, { pending_since: null, failed_runs: 0 })
    if (blocked) await callRpc(db, 'agent_flag', { p_conversation_id: id, p_reason: 'Resposta bloqueada pelo filtro de segurança', p_handoff: false })
    return { status: blocked ? 'blocked' : 'silent', usage }
  }

  const purpose = ctx.flags.handoff ? 'handoff' : 'reply'
  const sent: string[] = []
  try {
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await deps.sleep(1500 + Math.floor(deps.random() * 2500))
      const r = await sendText(deps.fetch, deps.cfg.zapi, conv.phone_e164, parts[i]!)
      await storeOutbound(db, id, r.messageId, parts[i]!, purpose)
      sent.push(parts[i]!)
    }
  } catch (e) {
    if (sent.length === 0) throw e
    deps.log('partial_send', { conversation: id, sent: sent.length, error: String(e instanceof Error ? e.message : e) })
  }

  // The summary reached the client: from now on a later inbound may confirm it.
  const pa = ctx.conv.pending_action
  const patch: Record<string, unknown> = { last_outbound_at: isoOf(deps.now()), failed_runs: 0 }
  if (pa && !pa.presented_baseline) patch.pending_action = { ...pa, presented_baseline: lastIn.created_at }
  await updateConversation(db, id, patch)
  // Clear pending only if nothing new arrived in the meantime.
  unwrapUpdate(await db.from('wa_conversations').update({ pending_since: null }).eq('id', id).eq('last_inbound_at', conv.last_inbound_at))
  return { status: 'sent', sent, usage }
}

function unwrapUpdate(res: { error: { message: string } | null }): void {
  if (res.error) throw new Error(res.error.message)
}
