// Time adjustment helpers: typed date/time parsing and free-gap math. Pure, no DOM, never throws.
import { isValidYMD, parseDateTime, toSaoPauloISO } from './datetime'

const BR_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/
const TIME_24H = /^(\d{2}):(\d{2})$/

/** 'DD/MM/AAAA' to 'YYYY-MM-DD'. Null for any other shape or an impossible date (31/02, 00/10, year < 2000). */
export function parseBRDate(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const m = BR_DATE.exec(input.trim())
  if (!m) return null
  const ymd = `${m[3]}-${m[2]}-${m[1]}`
  return Number(m[3]) >= 2000 && isValidYMD(ymd) ? ymd : null
}

/** 'HH:MM' (24h) to the same string. Null otherwise (24:00, 9:5, 12:60). */
export function parseTime24(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const t = input.trim()
  const m = TIME_24H.exec(t)
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? t : null
}

/** São Paulo ISO timestamp for typed date + time; null until both are valid. */
export function newStartFromInputs(dateText: unknown, timeText: unknown): string | null {
  const d = parseBRDate(dateText)
  const t = parseTime24(timeText)
  return d && t ? toSaoPauloISO(d, t) : null
}

/** Masks typing: digits only, inserts the separators ('1010' -> '10/10', '10102026' -> '10/10/2026'). */
export function maskBRDate(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8)
  return d.length > 4 ? `${d.slice(0, 2)}/${d.slice(2, 4)}/${d.slice(4)}` : d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
}

export function maskTime24(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 4)
  return d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d
}

export interface GapCandidate {
  appointmentId: string
  startsAt: string
  durationMin: number
  clientName: string
  serviceName: string
}

export interface Gap {
  start: string
  end: string
  minutes: number
  candidates: GapCandidate[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validates a rpc_get_free_gap row: invalid dates drop the gap, candidates with bad data or a duration that does
 * not fit the gap are dropped, and the rest are ordered by start.
 */
export function normalizeGap(row: unknown): Gap | null {
  if (!isObj(row)) return null
  const s = parseDateTime(row.gap_start)
  const e = parseDateTime(row.gap_end)
  if (!s || !e || e.getTime() <= s.getTime()) return null
  const minutes = Math.round((e.getTime() - s.getTime()) / 60_000)
  const list = Array.isArray(row.candidates) ? row.candidates : []
  const candidates: GapCandidate[] = []
  for (const c of list) {
    if (!isObj(c) || typeof c.appointment_id !== 'string') continue
    const start = parseDateTime(c.starts_at)
    const dur = Number(c.duration_min)
    if (!start || !Number.isFinite(dur) || dur <= 0 || dur > minutes) continue
    candidates.push({
      appointmentId: c.appointment_id,
      startsAt: start.toISOString(),
      durationMin: dur,
      clientName: typeof c.client_name === 'string' ? c.client_name : '',
      serviceName: typeof c.service_name === 'string' ? c.service_name : '',
    })
  }
  candidates.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.appointmentId.localeCompare(b.appointmentId))
  return { start: s.toISOString(), end: e.toISOString(), minutes, candidates }
}

/** True when the real end is before the planned end (both valid). */
export function endedEarly(realEnd: unknown, plannedEnd: unknown): boolean {
  const r = parseDateTime(realEnd)
  const p = parseDateTime(plannedEnd)
  return !!r && !!p && r.getTime() < p.getTime()
}
