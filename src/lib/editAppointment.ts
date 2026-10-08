// Appointment edit + agenda search helpers. Pure, no DOM, never throws.
import { formatTime, parseDateTime } from './datetime'

export const MIN_DURATION = 5
export const MAX_DURATION = 600
export const MIN_SEARCH_CHARS = 2

/** Typed minutes ('45', ' 90 ') to an integer 5..600. Null for anything else (decimals, signs, text, out of range). */
export function parseDurationInput(input: unknown): number | null {
  if (typeof input !== 'string') return null
  const t = input.trim()
  if (!/^\d{1,3}$/.test(t)) return null
  const n = Number(t)
  return n >= MIN_DURATION && n <= MAX_DURATION ? n : null
}

/** starts_at + minutes as ISO; null for an invalid start or duration. */
export function endsAtFrom(startsAt: unknown, minutes: unknown): string | null {
  const s = parseDateTime(startsAt)
  if (!s || typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < MIN_DURATION || minutes > MAX_DURATION) return null
  return new Date(s.getTime() + minutes * 60_000).toISOString()
}

/** 'HH:MM' (São Paulo) of starts_at + minutes, or null. */
export function endTimeLabel(startsAt: unknown, minutes: unknown): string | null {
  const end = endsAtFrom(startsAt, minutes)
  return end ? formatTime(end, '') || null : null
}

export type SearchKind = 'phone' | 'name'
export interface SearchQuery {
  text: string
  kind: SearchKind
}

/**
 * Normalizes what the user typed in the agenda search. Null below 2 characters (after trimming and, for names,
 * after dropping accents and punctuation). A query made only of digits and phone punctuation is a phone search.
 */
export function normalizeSearchQuery(input: unknown): SearchQuery | null {
  if (typeof input !== 'string') return null
  const t = input.trim().replace(/\s+/g, ' ')
  if (t.length < MIN_SEARCH_CHARS) return null
  if (/^[0-9 ()+.-]+$/.test(t)) {
    const digits = t.replace(/\D/g, '')
    return digits.length >= MIN_SEARCH_CHARS ? { text: digits, kind: 'phone' } : null
  }
  const folded = t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return folded.length >= MIN_SEARCH_CHARS ? { text: t, kind: 'name' } : null
}

export interface SearchHit {
  appointmentId: string | null
  clientId: string
  clientName: string
  startsAt: string | null
  professionalName: string
  serviceName: string
  status: string
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** Validates rpc_agenda_search rows: rows without a client id are dropped; an unparseable date becomes "no appointment". */
export function normalizeSearchRows(rows: unknown): SearchHit[] {
  if (!Array.isArray(rows)) return []
  const out: SearchHit[] = []
  for (const r of rows) {
    if (!isObj(r) || typeof r.client_id !== 'string') continue
    const start = parseDateTime(r.starts_at)
    const hasAppt = typeof r.appointment_id === 'string' && !!start
    out.push({
      appointmentId: hasAppt ? (r.appointment_id as string) : null,
      clientId: r.client_id,
      clientName: str(r.client_name),
      startsAt: hasAppt && start ? start.toISOString() : null,
      professionalName: str(r.professional_name),
      serviceName: str(r.service_name),
      status: str(r.status),
    })
  }
  return out
}
