// Safe time helpers for the agent. Pure TS, no Deno APIs. Mirrors src/lib/datetime.ts rules:
// never `new Date(x)` on unvalidated input. America/Sao_Paulo has had no DST since 2019 (fixed -03:00).

export const TZ = 'America/Sao_Paulo'
const SP_OFFSET_MIN = -180

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/

function validYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  const probe = new Date(Date.UTC(y, m - 1, d)) // numeric args only
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

/** Parses an ISO timestamp to epoch ms. Offset-less input is read as São Paulo time. Null when invalid. */
export function parseInstant(input: unknown): number | null {
  if (typeof input !== 'string') return null
  const t = DATE_TIME.exec(input.trim())
  if (!t) return null
  const [y, m, d, hh, mm, ss] = [t[1], t[2], t[3], t[4], t[5], t[6] ?? '0'].map(Number) as [number, number, number, number, number, number]
  if (!validYMD(y, m, d) || hh > 23 || mm > 59 || ss > 59) return null
  let offsetMin = SP_OFFSET_MIN
  const z = t[8]
  if (z === 'Z') offsetMin = 0
  else if (z) {
    const sign = z[0] === '-' ? -1 : 1
    const digits = z.slice(1).replace(':', '')
    const oh = Number(digits.slice(0, 2))
    const om = Number(digits.slice(2, 4) || '0')
    if (oh > 23 || om > 59) return null
    offsetMin = sign * (oh * 60 + om)
  }
  const millis = t[7] ? Number((t[7].slice(1) + '000').slice(0, 3)) : 0
  return Date.UTC(y, m - 1, d, hh, mm, ss, millis) - offsetMin * 60_000
}

/** Sortable key with microsecond precision for database timestamps ("...T14:32:10.123456+00:00"). */
export function tsKey(input: unknown): number | null {
  const ms = parseInstant(input)
  if (ms === null || typeof input !== 'string') return null
  const frac = DATE_TIME.exec(input.trim())?.[7]
  const micros = frac ? Number((frac.slice(1) + '000000').slice(3, 6)) : 0
  return ms * 1000 + micros
}

export function isoOf(ms: number): string {
  return new Date(ms).toISOString()
}

/** Valid 'YYYY-MM-DD' -> itself, else null. */
export function validYmd(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const m = DATE_ONLY.exec(input.trim())
  if (!m || !validYMD(Number(m[1]), Number(m[2]), Number(m[3]))) return null
  return input.trim()
}

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23',
})

export interface SPParts {
  ymd: string
  hh: number
  mm: number
  minutes: number
  weekday: number
}

/** Wall-clock parts in São Paulo for an epoch ms. */
export function spParts(ms: number): SPParts {
  const p: Record<string, string> = {}
  for (const x of partsFmt.formatToParts(new Date(ms))) p[x.type] = x.value
  const ymd = `${p.year}-${p.month}-${p.day}`
  const hh = Number(p.hour)
  const mm = Number(p.minute)
  const weekday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay()
  return { ymd, hh, mm, minutes: hh * 60 + mm, weekday }
}

export function addDays(ymd: string, n: number): string {
  const m = DATE_ONLY.exec(ymd)
  if (!m) return ymd
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n)).toISOString().slice(0, 10)
}

export function hhmmToMinutes(input: unknown, fallback: number): number {
  if (typeof input !== 'string') return fallback
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(input)
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback
}

/** Service window in São Paulo. It may not cross midnight: start <= now < end. */
export function inWindow(nowMs: number, start: unknown, end: unknown): boolean {
  const s = hhmmToMinutes(start, 7 * 60)
  const e = hhmmToMinutes(end, 22 * 60)
  const m = spParts(nowMs).minutes
  return m >= s && m < e
}

const WEEKDAYS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado']

export function weekdayName(w: number): string {
  return WEEKDAYS[w] ?? ''
}

export function weekdayOfYmd(ymd: string): number {
  const m = DATE_ONLY.exec(ymd)
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() : 0
}

export function ddmm(ymd: string): string {
  return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`
}

/** "segunda-feira, 05/10 às 09:00" */
export function humanSlot(ms: number): string {
  const p = spParts(ms)
  return `${weekdayName(p.weekday)}, ${ddmm(p.ymd)} às ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}

export function hhmm(ms: number): string {
  const p = spParts(ms)
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`
}
