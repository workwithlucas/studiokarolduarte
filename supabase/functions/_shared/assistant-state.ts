// Pending-proposal state machine, pure. The database does the atomic UPDATE (pending -> confirmed/cancelled);
// these helpers state the same rule in code, so the claim predicate and the explanation of a lost claim agree.
import type { PendingView, UndoItem } from './assistant-types.ts'
import { parseInstant } from './time.ts'

export interface PendingState {
  status: PendingView['status']
  expires_at: string
}

/** The WHERE clause of the confirm UPDATE: status = 'pending' AND expires_at > now. */
export function claimable(p: PendingState, nowMs: number): boolean {
  const exp = parseInstant(p.expires_at)
  return p.status === 'pending' && exp !== null && exp > nowMs
}

/** The WHERE clause of the cancel UPDATE. */
export const cancelable = (p: PendingState): boolean => p.status === 'pending'

export type LostClaim = 'missing' | 'replay' | 'expire_now' | 'cancelled' | 'expired'

/** Why a confirm did not execute. `replay` returns the stored result and runs nothing. */
export function lostClaim(p: PendingState | null): LostClaim {
  if (!p) return 'missing'
  if (p.status === 'confirmed' || p.status === 'failed') return 'replay'
  if (p.status === 'pending') return 'expire_now' // still pending, so its time ran out: discard it
  return p.status === 'cancelled' ? 'cancelled' : 'expired'
}

/** What the UI needs to know about a pending row (the database row is the only source of truth). */
export function pendingViewOf(p: PendingState & { id: string; undo: UndoItem[] | null }): PendingView {
  return {
    id: p.id,
    status: p.status,
    expires_at: p.expires_at,
    undoable: p.status === 'confirmed' || p.status === 'failed' ? (p.undo ?? []).filter((u) => !u.done).map((u) => u.index) : [],
  }
}
