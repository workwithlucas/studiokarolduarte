// agent-run: one guarded turn of Thaís for a conversation.
// The model proposes; every write it asks for passes a code gate (tools.ts / decision.ts), and every reply goes out
// through the single outbound function (outbound.ts), which re-reads settings and thread right before Z-API.
import { callMessages, textOf, type ChatMessage, type MessagesRequest, type TextBlock, type ToolResultBlock } from './anthropic.ts'
import { buildDynamicBlock, buildMessages } from './context.ts'
import { callRpc, getConversation, latestInbound, loadSettings, recentMessages, updateConversation } from './db.ts'
import { evaluateGates } from './decision.ts'
import { dropForbiddenSentences, formatReply, hasForbiddenPhrase } from './filters.ts'
import { awayDue } from './gates.ts'
import { KB } from './kb.ts'
import { getGateState, recordDecision, sendReply, type ReplyOutcome } from './outbound.ts'
import { PERSONA } from './prompt.ts'
import { executeTool, TOOL_DEFS, type ToolCtx } from './tools.ts'
import { inWindow, isoOf } from './time.ts'
import type { Deps } from './types.ts'

export const MAX_ITERATIONS = 6
export const RUN_BUDGET_MS = 60_000
export const HANDOFF_TEXT = 'Vou pedir para a Karol falar com você por aqui, tá bem?'

export interface RunOutcome {
  status: 'sent' | 'not_claimed' | 'skipped' | 'away' | 'handoff' | 'silent' | 'blocked' | 'failed' | 'shadow' | 'breaker'
  reason?: string
  sent?: string[]
  usage?: { input: number; output: number }
}

const CORRECTION = `CORREÇÃO OBRIGATÓRIA: sua resposta anterior continha uma frase proibida (dizer que você não consegue ver, abrir, ler, ouvir ou interpretar imagens, figurinhas ou áudios, ou pedir para "mandar por texto"). Reescreva a resposta sem essa frase. Responda ao conteúdo da mensagem normalmente e nunca fale de limitações de mídia.`

const errText = (e: unknown) => String(e instanceof Error ? e.message : e)

export async function runAgent(deps: Deps, conversationId: string): Promise<RunOutcome> {
  const claimed = await callRpc<boolean>(deps.db, 'agent_claim', { p_conversation_id: conversationId, p_lease_seconds: 90 })
  if (!claimed) return { status: 'not_claimed' }
  try {
    return await runClaimed(deps, conversationId)
  } catch (e) {
    deps.log('agent_run_failed', { conversation: conversationId, error: errText(e) })
    return { status: 'failed' } // never a message to the client
  } finally {
    try {
      await callRpc(deps.db, 'agent_release', { p_conversation_id: conversationId })
    } catch (e) {
      deps.log('release_failed', { error: errText(e) })
    }
  }
}

/** The job for this thread is finished (answered, skipped or failed for good): nothing stays queued. */
async function clearPending(deps: Deps, id: string): Promise<void> {
  await updateConversation(deps.db, id, { pending_since: null })
}

/** Clear the queued job only if nothing new arrived in the meantime. */
async function clearPendingIfQuiet(deps: Deps, id: string, lastInboundAt: string | null): Promise<void> {
  const res = await deps.db.from('wa_conversations').update({ pending_since: null }).eq('id', id).eq('last_inbound_at', lastInboundAt)
  if (res.error) throw new Error(res.error.message)
}

async function runClaimed(deps: Deps, id: string): Promise<RunOutcome> {
  // A newer message that lands while we generate changes the thread head: the send is aborted and the run goes once
  // more with fresh context. A second change ends the run without a reply (the sweep / the newer message take over).
  for (let round = 0; round < 2; round++) {
    const out = await runRound(deps, id, round === 1)
    if (out !== 'requeue') return out
  }
  return { status: 'skipped', reason: 'head_changed' }
}

async function runRound(deps: Deps, id: string, lastRound: boolean): Promise<RunOutcome | 'requeue'> {
  const { db } = deps
  const conv = await getConversation(db, id)
  if (!conv) return { status: 'skipped', reason: 'no_conversation' }
  const target = await latestInbound(db, id)
  if (!target?.external_id) {
    await clearPending(deps, id)
    return { status: 'skipped', reason: 'no_inbound' }
  }
  const messageId = target.external_id

  // ---- gates 1-6, before any model call; first match stops; the outcome is stored
  const st = await getGateState(db, id, messageId)
  const snap = { liveSince: st.live_since, maxAgeMinutes: st.max_inbound_age_minutes }
  const stop = evaluateGates(st, deps.now())
  if (stop) {
    if (stop.action !== 'skipped_duplicate') {
      await recordDecision(db, { messageId, conversationId: id, inboundAt: st.message?.sent_at ?? null, action: stop.action, reason: stop.reason, ...snap })
    }
    await clearPending(deps, id)
    return { status: 'skipped', reason: stop.action === 'skipped_duplicate' ? stop.reason : stop.action }
  }
  const inboundAt = st.message!.sent_at
  const decisionId = crypto.randomUUID()
  const headAtStart = st.head
  const settings = await loadSettings(db)

  const finish = async (r: ReplyOutcome, ok: RunOutcome): Promise<RunOutcome | 'requeue'> => {
    if (r.status === 'head_changed') {
      if (!lastRound) return 'requeue'
      await recordDecision(db, { messageId, conversationId: id, inboundAt, action: 'no_reply', reason: 'head_changed', ...snap })
      return { status: 'skipped', reason: 'head_changed' }
    }
    await clearPendingIfQuiet(deps, id, conv.last_inbound_at)
    if (r.status === 'stopped') return { status: 'skipped', reason: r.action }
    if (r.status === 'breaker') return { status: 'breaker' }
    if (r.status === 'shadow') return { status: 'shadow', sent: [r.draft] }
    return ok
  }

  try {
    // Outside the window: no LLM call. The away message goes out once per 12h and is the final answer to this message.
    if (!inWindow(deps.now(), settings.agent_window_start, settings.agent_window_end)) {
      if (!awayDue(conv.away_sent_at, deps.now())) {
        await recordDecision(db, { messageId, conversationId: id, inboundAt, action: 'no_reply', reason: 'away_already_sent', ...snap })
        await clearPending(deps, id)
        return { status: 'skipped', reason: 'outside_window' }
      }
      const r = await sendReply(deps, { conversationId: id, phone: conv.phone_e164, messageId, inboundAt, headAtStart, parts: [settings.agent_away_message], purpose: 'away', action: 'replied', reason: 'away', decisionId })
      if (r.status === 'sent') await updateConversation(db, id, { away_sent_at: isoOf(deps.now()), last_outbound_at: isoOf(deps.now()) })
      return await finish(r, { status: 'away', sent: [settings.agent_away_message] })
    }

    // Two audios in a row that could not be transcribed: hand over, no LLM call.
    if (conv.audio_failures >= 2) {
      await callRpc(db, 'agent_flag', { p_conversation_id: id, p_reason: 'Mensagens de voz sem transcrição', p_handoff: true, p_handoff_hours: 12 })
      const r = await sendReply(deps, { conversationId: id, phone: conv.phone_e164, messageId, inboundAt, headAtStart, parts: [HANDOFF_TEXT], purpose: 'handoff', action: 'handoff', reason: 'audio', decisionId })
      if (r.status === 'sent') await updateConversation(db, id, { last_outbound_at: isoOf(deps.now()) })
      return await finish(r, { status: 'handoff', reason: 'audio', sent: [HANDOFF_TEXT] })
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

    if (parts.length === 0) {
      await recordDecision(db, { messageId, conversationId: id, inboundAt, action: 'no_reply', reason: blocked ? 'blocked' : 'silent', ...snap })
      await updateConversation(db, id, { pending_since: null, failed_runs: 0 })
      if (blocked) await callRpc(db, 'agent_flag', { p_conversation_id: id, p_reason: 'Resposta bloqueada pelo filtro de segurança', p_handoff: false })
      return { status: blocked ? 'blocked' : 'silent', usage }
    }

    const handoff = ctx.flags.handoff
    const r = await sendReply(deps, {
      conversationId: id, phone: conv.phone_e164, messageId, inboundAt, headAtStart, parts,
      purpose: handoff ? 'handoff' : 'reply', action: handoff ? 'handoff' : 'replied', reason: handoff ? 'handoff_to_human' : 'reply', decisionId,
    })
    if (r.status === 'sent') {
      // The summary reached the client: from now on a later inbound may confirm it.
      const pa = ctx.conv.pending_action
      const patch: Record<string, unknown> = { last_outbound_at: isoOf(deps.now()), failed_runs: 0 }
      if (pa && !pa.presented_baseline) patch.pending_action = { ...pa, presented_baseline: lastIn.created_at }
      await updateConversation(db, id, patch)
    }
    return await finish(r, { status: 'sent', sent: r.status === 'sent' ? r.sent : [], usage })
  } catch (e) {
    // The real error is stored (never shown to the client). The sweep retries at most twice, never old messages.
    const error = errText(e)
    deps.log('agent_run_failed', { conversation: id, message: messageId, error })
    try {
      await recordDecision(db, { messageId, conversationId: id, inboundAt, action: 'error', reason: 'run_failed', errorText: error, id: decisionId, ...snap })
      const c = await getConversation(db, id)
      if (c) await updateConversation(db, id, { failed_runs: c.failed_runs + 1 })
    } catch (e2) {
      deps.log('failed_runs_update_failed', { error: errText(e2) })
    }
    return { status: 'failed', reason: error }
  }
}
