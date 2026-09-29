// Safe date handling. Never call `new Date(x)` on unvalidated input: use these helpers.
// All display is in America/Sao_Paulo (no DST since 2019, so a fixed -03:00 offset is exact).

import { TZDate } from '@date-fns/tz'
import { addDays, format, startOfWeek } from 'date-fns'
import { ptBR } from 'date-fns/locale'

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

// ---------------------------------------------------------------- date-fns + TZDate helpers
// Invalid input never throws: each helper returns its fallback.

/** Any valid date/timestamp as a São Paulo TZDate; null when invalid. */
export function toSP(input: unknown): TZDate | null {
  const d = parseDateTime(input)
  return d ? new TZDate(d.getTime(), TZ) : null
}

export function nowSP(): TZDate {
  return new TZDate(Date.now(), TZ)
}

export function isValidYMD(input: unknown): input is string {
  return typeof input === 'string' && DATE_ONLY.test(input.trim()) && parseDateTime(input) !== null
}

/** 'YYYY-MM-DD' of a timestamp in São Paulo. */
export function ymdOf(input: unknown, fallback = ''): string {
  const d = toSP(input)
  return d ? format(d, 'yyyy-MM-dd') : fallback
}

export function addDaysYMD(date: unknown, n: number, fallback = ''): string {
  const d = toSP(date)
  if (!d || !Number.isFinite(n)) return fallback
  return format(addDays(d, Math.trunc(n)), 'yyyy-MM-dd')
}

/** Monday of the week containing the date. */
export function weekStartYMD(date: unknown, fallback = ''): string {
  const d = toSP(date)
  return d ? format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd') : fallback
}

/** 0 = Sunday … 6 = Saturday (matches working_hours.weekday); null when invalid. */
export function weekdayOf(date: unknown): number | null {
  const d = toSP(date)
  return d ? d.getDay() : null
}

/** Minutes since local midnight (São Paulo) of a timestamp. */
export function minutesOfDaySP(input: unknown, fallback = 0): number {
  const d = toSP(input)
  return d ? d.getHours() * 60 + d.getMinutes() : fallback
}

function dayStart(date: unknown): Date | null {
  return typeof date === 'string' ? parseDateTime(toSaoPauloISO(date, '00:00')) : null
}

/** Minutes between the start of `date` (São Paulo) and a timestamp; can be negative or > 1440. */
export function minutesSinceDayStart(date: unknown, ts: unknown, fallback = 0): number {
  const start = dayStart(date)
  const t = parseDateTime(ts)
  if (!start || !t) return fallback
  return Math.round((t.getTime() - start.getTime()) / 60_000)
}

/** ISO timestamp for a São Paulo date plus minutes since midnight. Null when invalid. */
export function isoAtMinutes(date: unknown, minutes: number): string | null {
  const start = dayStart(date)
  if (!start || !Number.isFinite(minutes)) return null
  return new Date(start.getTime() + minutes * 60_000).toISOString()
}

export function minutesToHHMM(minutes: number): string {
  if (!Number.isFinite(minutes)) return '--:--'
  const m = Math.max(0, Math.trunc(minutes))
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** 'HH:MM' or 'HH:MM:SS' to minutes. */
export function hhmmToMinutes(input: unknown, fallback = 0): number {
  if (typeof input !== 'string') return fallback
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(input.trim())
  if (!m) return fallback
  const [h, mm] = [Number(m[1]), Number(m[2])]
  return h > 23 || mm > 59 ? fallback : h * 60 + mm
}

const WEEKDAY_ABBR = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb']

/** 'seg, 29 set' (rendered uppercase by the UI). */
export function formatDayShort(date: unknown, fallback = '—'): string {
  const d = toSP(date)
  return d ? `${WEEKDAY_ABBR[d.getDay()]}, ${format(d, 'dd MMM', { locale: ptBR }).replace(/\./g, '')}` : fallback
}

/** 'sexta-feira, 29 de setembro' (rendered uppercase by the UI). */
export function formatDayLong(date: unknown, fallback = '—'): string {
  const d = toSP(date)
  return d ? format(d, "EEEE, d 'de' MMMM", { locale: ptBR }) : fallback
}
