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

export const TITLE_MAX = 60

/** Title of an archived thread: the first user message, whitespace collapsed, at most 60 characters. */
export function threadTitle(firstUserBody: string | null | undefined): string {
  const t = (firstUserBody ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return 'Conversa sem título'
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t
}

/** Page size for the list actions: default when missing or invalid, clamped to max. */
export function pageSize(v: unknown, def: number, max: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 ? Math.min(v, max) : def
}

/** A proposal belongs to an archived conversation when it carries a thread other than the current one. */
export const inArchivedThread = (p: { thread_id: string | null }, currentThread: string): boolean =>
  p.thread_id !== null && p.thread_id !== currentThread

/** The button Desfazer on a log row: only a done action whose undo data is still stored. */
export const undoVisible = (a: { status: string; undoable: boolean }): boolean => a.status === 'done' && a.undoable
