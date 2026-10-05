// Pre-model / pre-send gates. ONE pure function; first match stops; every outcome is stored in agent_decisions.
// Nothing in here touches the network or the database: the caller passes a fresh snapshot (agent_gate_state).
import { phoneKey } from './phone.ts'
import { parseInstant } from './time.ts'
import type { AgentMode } from './types.ts'

export type DecisionAction =
  | 'replied' | 'shadow_drafted' | 'no_reply' | 'handoff' | 'skipped_mode' | 'skipped_stale' | 'skipped_human'
  | 'skipped_before_live' | 'skipped_answered' | 'skipped_duplicate' | 'cancelled_off' | 'circuit_breaker' | 'error'

/** Snapshot returned by the SQL function agent_gate_state(). Timestamps are ISO strings from the database. */
export interface GateState {
  db_now: string
  mode: AgentMode
  test_numbers: string[]
  human_pause_hours: number
  live_since: string | null
  off_since: string | null
  max_inbound_age_minutes: number
  breaker_max_sends: number
  breaker_window_minutes: number
  conv: { id: string; phone_e164: string; phone_key: string | null; mode: 'agent' | 'human'; human_until: string | null } | null
  message: { message_id: string; sent_at: string } | null
  latest_inbound: { message_id: string; sent_at: string } | null
  last_agent_out_at: string | null
  last_staff_out_at: string | null
  head: string
  decision: { id: string; action: DecisionAction; reason: string | null; attempts: number } | null
  recent_agent_sends: number
}

export interface GateStop {
  action: Extract<DecisionAction, 'skipped_duplicate' | 'skipped_mode' | 'skipped_before_live' | 'skipped_stale' | 'skipped_answered' | 'skipped_human' | 'no_reply'>
  reason: string
}

/** A decision of kind 'error' may be retried at most twice (3 attempts in total). */
export const MAX_ATTEMPTS = 3

const after = (t: string | null, ref: number): boolean => {
  const ms = parseInstant(t)
  return ms !== null && ms > ref
}

/**
 * Gate order (spec):
 *  1 already decided (duplicate / quarantined / cancelled) -> skipped_duplicate (an 'error' decision may retry)
 *  2 mode off; test and phone not allow-listed -> skipped_mode (shadow runs everything)
 *  3 inbound before live_since and not answered (quarantined, or older than going live) -> skipped_before_live
 *  4 older than max_inbound_age_minutes -> skipped_stale
 *  5 any outbound after the inbound -> skipped_answered; staff inside human_pause_hours or thread paused -> skipped_human
 *  6 only the latest inbound of a thread is answered -> no_reply (superseded)
 * `checks` limits the run to a subset (the send-time re-check runs 2-5 only, the thread head handles 6).
 */
export function evaluateGates(st: GateState, nowMs: number, checks: { duplicate?: boolean; latest?: boolean; ignorePause?: boolean } = { duplicate: true, latest: true }): GateStop | null {
  const conv = st.conv
  const msg = st.message
  if (checks.duplicate !== false && st.decision) {
    const retriable = st.decision.action === 'error' && st.decision.attempts < MAX_ATTEMPTS
    if (!retriable) return { action: 'skipped_duplicate', reason: `already_decided:${st.decision.action}` }
  }
  if (!conv || !msg) return { action: 'skipped_duplicate', reason: 'message_not_found' }

  // 2 mode
  if (st.mode === 'off') return { action: 'skipped_mode', reason: 'off' }
  if (st.mode === 'test') {
    const key = conv.phone_key ?? phoneKey(conv.phone_e164)
    const allowed = st.test_numbers.some((n) => phoneKey(n) === key && key !== null)
    if (!allowed) return { action: 'skipped_mode', reason: 'not_in_test_numbers' }
  }

  const inboundMs = parseInstant(msg.sent_at)
  if (inboundMs === null) return { action: 'skipped_stale', reason: 'invalid_inbound_time' }
  const answered = after(st.last_agent_out_at, inboundMs) || after(st.last_staff_out_at, inboundMs)

  // 3 before live (shadow only drafts, so it has no "before live")
  if (st.mode !== 'shadow') {
    const live = parseInstant(st.live_since)
    if (live === null) return { action: 'skipped_before_live', reason: 'live_since_missing' }
    if (inboundMs < live && !answered) return { action: 'skipped_before_live', reason: 'before_live' }
  }

  // 4 stale
  if (nowMs - inboundMs > st.max_inbound_age_minutes * 60_000) return { action: 'skipped_stale', reason: 'older_than_max_age' }

  // 5 answered by anyone, then human priority
  if (after(st.last_agent_out_at, inboundMs)) return { action: 'skipped_answered', reason: 'agent_answered' }
  if (after(st.last_staff_out_at, inboundMs)) return { action: 'skipped_answered', reason: 'staff_answered' }
  const staff = parseInstant(st.last_staff_out_at)
  if (staff !== null && nowMs - staff < st.human_pause_hours * 3_600_000) return { action: 'skipped_human', reason: 'staff_window' }
  // ignorePause: the handoff sentence goes out after the agent itself paused the thread
  if (conv.mode === 'human' && checks.ignorePause !== true) {
    const until = parseInstant(conv.human_until)
    if (conv.human_until === null || (until !== null && until > nowMs)) return { action: 'skipped_human', reason: 'thread_paused' }
  }

  // 6 latest inbound only
  if (checks.latest !== false && st.latest_inbound && st.latest_inbound.message_id !== msg.message_id) {
    return { action: 'no_reply', reason: 'superseded' }
  }
  return null
}

/** Mode gate for sends that are not replies (reminders, confirmations, notices). Shadow never sends. */
export function scheduledSendAllowed(st: Pick<GateState, 'mode' | 'test_numbers'>, phone: string): boolean {
  if (st.mode === 'live') return true
  if (st.mode !== 'test') return false
  const key = phoneKey(phone)
  return key !== null && st.test_numbers.some((n) => phoneKey(n) === key)
}
