// THE outbound function. No other module may call Z-API (enforced by tests/agent/outbound-only.test.ts).
// Immediately before every Z-API call the settings and the thread are re-read from the database (no cache, no
// in-memory copy) and the gates run again.
import { callRpc } from './db.ts'
import { evaluateGates, scheduledSendAllowed, type DecisionAction, type GateState, type GateStop } from './decision.ts'
import type { Deps } from './types.ts'
import { sendText } from './zapi.ts'

export async function getGateState(db: Deps['db'], conversationId: string, messageId: string, excludeDecision: string | null = null): Promise<GateState> {
  return await callRpc<GateState>(db, 'agent_gate_state', { p_conversation_id: conversationId, p_message_id: messageId, p_exclude_decision: excludeDecision })
}

export interface DecisionRecord {
  messageId: string
  conversationId: string
  inboundAt: string | null
  action: DecisionAction
  reason: string
  errorText?: string | null
  draftText?: string | null
  id?: string | null
  liveSince?: string | null
  maxAgeMinutes?: number | null
}

export async function recordDecision(db: Deps['db'], d: DecisionRecord): Promise<string> {
  return await callRpc<string>(db, 'agent_record_decision', {
    p_message_id: d.messageId, p_conversation_id: d.conversationId, p_inbound_at: d.inboundAt, p_action: d.action, p_reason: d.reason,
    p_error_text: d.errorText ?? null, p_draft_text: d.draftText ?? null, p_id: d.id ?? null,
    p_live_since: d.liveSince ?? null, p_max_age: d.maxAgeMinutes ?? null,
  })
}

export interface ReplyRequest {
  conversationId: string
  phone: string
  /** Provider id of the inbound message being answered. */
  messageId: string
  inboundAt: string
  /** Thread head (agent_gate_state.head) when this decision started. */
  headAtStart: string
  parts: string[]
  purpose: 'reply' | 'away' | 'handoff'
  /** What is recorded when the reply goes out. */
  action: Extract<DecisionAction, 'replied' | 'handoff'>
  reason: string
  decisionId: string
}

export type ReplyOutcome =
  | { status: 'sent'; sent: string[] }
  | { status: 'shadow'; draft: string }
  | { status: 'stopped'; action: GateStop['action']; reason: string; sent: string[] }
  | { status: 'head_changed' }
  | { status: 'breaker' }

const msg = (e: unknown) => String(e instanceof Error ? e.message : e)

/** Sends the parts of one reply. Every part is gated again against a fresh read of settings and thread. */
export async function sendReply(deps: Deps, req: ReplyRequest): Promise<ReplyOutcome> {
  const { db } = deps
  const sent: string[] = []
  let last: GateState | null = null
  const base = () => ({
    messageId: req.messageId, conversationId: req.conversationId, inboundAt: req.inboundAt, id: req.decisionId,
    liveSince: last?.live_since ?? null, maxAgeMinutes: last?.max_inbound_age_minutes ?? null,
  })

  for (let i = 0; i < req.parts.length; i++) {
    if (i > 0) await deps.sleep(1500 + Math.floor(deps.random() * 2500))
    const st = await getGateState(db, req.conversationId, req.messageId, req.decisionId)
    last = st
    const stop = evaluateGates(st, deps.now(), { duplicate: i === 0, latest: false, ignorePause: req.action === 'handoff' })
    if (stop) {
      if (sent.length === 0) {
        await recordDecision(db, { ...base(), action: stop.action, reason: stop.reason })
      } else {
        await recordDecision(db, { ...base(), action: req.action, reason: `partial:${stop.reason}` })
      }
      return { status: 'stopped', action: stop.action, reason: stop.reason, sent }
    }
    if (i === 0) {
      if (st.head !== req.headAtStart) return { status: 'head_changed' }
      if (st.mode === 'shadow') {
        const draft = req.parts.join('\n\n')
        await recordDecision(db, { ...base(), action: 'shadow_drafted', reason: req.reason, draftText: draft })
        return { status: 'shadow', draft }
      }
      if (st.recent_agent_sends >= st.breaker_max_sends) {
        // the decision first: switching off cancels queued jobs and must not overwrite this outcome
        await recordDecision(db, { ...base(), action: 'circuit_breaker', reason: `${st.recent_agent_sends + 1} envios em ${st.breaker_window_minutes} min (limite ${st.breaker_max_sends})` })
        await callRpc(db, 'rpc_agent_set_mode', { p_mode: 'off' })
        deps.log('circuit_breaker', { sends: st.recent_agent_sends, window_min: st.breaker_window_minutes })
        return { status: 'breaker' }
      }
    }
    try {
      // registered BEFORE Z-API so a fast webhook echo is recognised as ours; the provider id is attached right after
      const sendId = await callRpc<string>(db, 'agent_register_send', { p_conversation_id: req.conversationId, p_decision_id: req.decisionId, p_body: req.parts[i]! })
      const r = await sendText(deps.fetch, deps.cfg.zapi, req.phone, req.parts[i]!)
      await callRpc(db, 'agent_attach_send', { p_send_id: sendId, p_external_id: r.messageId, p_purpose: req.purpose })
      sent.push(req.parts[i]!)
    } catch (e) {
      if (sent.length === 0) throw e
      deps.log('partial_send', { conversation: req.conversationId, sent: sent.length, error: msg(e) })
      await recordDecision(db, { ...base(), action: req.action, reason: 'partial_send', errorText: msg(e) })
      return { status: 'sent', sent }
    }
  }
  await recordDecision(db, { ...base(), action: req.action, reason: req.reason })
  return { status: 'sent', sent }
}

export interface ScheduledSend {
  conversationId: string
  phone: string
  text: string
  purpose: 'confirmation' | 'reply'
}

/**
 * Reminders, confirmations and reschedule notices: not replies, so no inbound gates. The mode is re-read right
 * before Z-API; off and shadow never send, test sends only to allow-listed numbers.
 */
export async function sendScheduled(deps: Deps, s: ScheduledSend): Promise<{ sent: boolean; reason?: string; messageRowId?: string | null }> {
  const st = await getGateState(deps.db, s.conversationId, '')
  if (!scheduledSendAllowed(st, s.phone)) return { sent: false, reason: `mode_${st.mode}` }
  const sendId = await callRpc<string>(deps.db, 'agent_register_send', { p_conversation_id: s.conversationId, p_decision_id: null, p_body: s.text })
  const r = await sendText(deps.fetch, deps.cfg.zapi, s.phone, s.text)
  const id = await callRpc<string | null>(deps.db, 'agent_attach_send', { p_send_id: sendId, p_external_id: r.messageId, p_purpose: s.purpose })
  return { sent: true, messageRowId: id }
}
