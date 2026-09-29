// Safe date handling. Never call `new Date(x)` on unvalidated input: use these helpers.
// All display is in America/Sao_Paulo (no DST since 2019, so a fixed -03:00 offset is exact).

export const TZ = 'America/Sao_Paulo'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/

function validYMD(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false
  const probe = new Date(Date.UTC(y, m - 1, d)) // numeric args only: never parses strings
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d
}

/** Parses an ISO date ('YYYY-MM-DD') or timestamp. Offset-less timestamps are read as São Paulo time. */
export function parseDateTime(input: unknown): Date | null {
  if (input instanceof Date) return Number.isNaN(input.getTime()) ? null : input
  if (typeof input !== 'string') return null
  const s = input.trim()

  const d = DATE_ONLY.exec(s)
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])]
    if (!validYMD(y, m, day)) return null
    return new Date(Date.UTC(y, m - 1, day, 15)) // 12:00 in São Paulo: safe from day rollover
  }

  const t = DATE_TIME.exec(s)
  if (!t) return null
  const [y, m, day, hh, mm, ss] = [t[1], t[2], t[3], t[4], t[5], t[6] ?? '0'].map(Number)
  if (!validYMD(y, m, day) || hh > 23 || mm > 59 || ss > 59) return null

  let offsetMin = -180
  const z = t[7]
  if (z === 'Z') offsetMin = 0
  else if (z) {
    const sign = z[0] === '-' ? -1 : 1
    const digits = z.slice(1).replace(':', '')
    const oh = Number(digits.slice(0, 2))
    const om = Number(digits.slice(2, 4) || '0')
    if (oh > 23 || om > 59) return null
    offsetMin = sign * (oh * 60 + om)
  }
  const ms = Date.UTC(y, m - 1, day, hh, mm, ss) - offsetMin * 60_000
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date
}

function fmt(input: unknown, opts: Intl.DateTimeFormatOptions, fallback: string): string {
  const date = parseDateTime(input)
  if (!date) return fallback
  return new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(date)
}

export function formatDate(input: unknown, fallback = '—'): string {
  return fmt(input, { day: '2-digit', month: '2-digit', year: 'numeric' }, fallback)
}

export function formatTime(input: unknown, fallback = '—'): string {
  return fmt(input, { hour: '2-digit', minute: '2-digit', hour12: false }, fallback)
}

export function formatDateTime(input: unknown, fallback = '—'): string {
  return fmt(input, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }, fallback)
}

/** Today's date in São Paulo as 'YYYY-MM-DD' (mirrors SQL today_sp()). */
export function todaySP(now: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return p
}

/** Builds an ISO timestamptz string (with -03:00) from a São Paulo local date and 'HH:MM'. Null when invalid. */
export function toSaoPauloISO(date: string, time: string): string | null {
  const parsed = parseDateTime(`${date}T${time}`)
  if (!parsed || !/^\d{2}:\d{2}$/.test(time)) return null
  return `${date}T${time}:00-03:00`
}
