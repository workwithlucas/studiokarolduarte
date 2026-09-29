// Client CSV import: decode, parse, plan (preview), run. Pure logic: the UI and the flow test pass in the RPC.
import Papa from 'papaparse'
import { isValidYMD } from '../datetime'

export type Delimiter = ',' | ';' | '\t'
export type Field = 'name' | 'phone' | 'birthday' | 'external_code' | 'notes' | 'credit'

// ---------------------------------------------------------------- decode
/** UTF-8 first (BOM stripped); when it produces replacement characters, the file is windows-1252. */
export function decodeCsv(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let text = new TextDecoder('utf-8').decode(bytes)
  if (text.includes('�')) text = new TextDecoder('windows-1252').decode(bytes)
  return text.replace(/^﻿/, '')
}

/** Picks the delimiter that occurs most in the header line (outside quotes). Ties favour ',' then ';'. */
export function detectDelimiter(text: string): Delimiter {
  const first = text.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const count: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (const ch of first) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch in count) count[ch as Delimiter]++
  }
  const order: Delimiter[] = [',', ';', '\t']
  return order.reduce((best, d) => (count[d] > count[best] ? d : best), ',' as Delimiter)
}

export interface ParsedCsv {
  delimiter: Delimiter
  headers: string[]
  rows: string[][]
}

export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, '')
  const delimiter = detectDelimiter(clean)
  const res = Papa.parse<string[]>(clean, { delimiter, skipEmptyLines: 'greedy' })
  const [headers = [], ...rows] = res.data
  return { delimiter, headers: headers.map((h) => h.trim()), rows }
}

// ---------------------------------------------------------------- headers
const ALIASES: Record<Field, string[]> = {
  name: ['nome', 'name'],
  phone: ['telefone', 'celular', 'whatsapp', 'phone'],
  birthday: ['aniversario', 'nascimento', 'birthday'],
  external_code: ['codigo_externo', 'codigo', 'cod', 'external_code'],
  notes: ['observacoes', 'obs', 'notes'],
  credit: ['credito', 'credito_loja'],
}

export function normalizeHeader(h: string): string {
  return h
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export interface HeaderMap {
  index: Partial<Record<Field, number>>
  /** Required columns that were not found. */
  missing: Field[]
}

export function matchHeaders(headers: string[]): HeaderMap {
  const index: Partial<Record<Field, number>> = {}
  headers.forEach((h, i) => {
    const n = normalizeHeader(h)
    for (const f of Object.keys(ALIASES) as Field[]) {
      if (index[f] === undefined && ALIASES[f].includes(n)) index[f] = i
    }
  })
  return { index, missing: index.name === undefined ? ['name'] : [] }
}

// ---------------------------------------------------------------- field parsers
/** dd/MM/yyyy or yyyy-MM-dd → 'yyyy-MM-dd'; null when blank or invalid. */
export function parseBirthday(input: string | null | undefined): string | null {
  const s = (input ?? '').trim()
  if (!s) return null
  let ymd: string | null = null
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s)
  if (br) ymd = `${br[3]}-${br[2].padStart(2, '0')}-${br[1].padStart(2, '0')}`
  else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) ymd = s
  return ymd && isValidYMD(ymd) ? ymd : null
}

/** Mirrors SQL normalize_phone: E.164 digits, 55 prepended for 10-11 digits, null when invalid. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (input == null) return null
  const d = input.replace(/\D/g, '').replace(/^0+/, '')
  if (d.length === 10 || d.length === 11) return `55${d}`
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d
  return null
}

/** 'R$ 1.234,56' | '12,50' | '12.50' → cents. Null when not a number. */
export function parseCreditCents(input: string | null | undefined): number | null {
  let s = (input ?? '').replace(/R\$/gi, '').replace(/\s/g, '')
  if (!s) return null
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, '')
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

export function creditNote(cents: number): string {
  return `Crédito em loja: R$ ${(cents / 100).toFixed(2).replace('.', ',')}`
}

// ---------------------------------------------------------------- name matching (mirrors _name_key + pg_trgm similarity)
export function nameKey(p: string): string {
  return p
    .toLowerCase()
    .replace(/ph/g, 'f')
    .replace(/ss/g, 's')
    .replace(/[áàâãäéèêëíìîïóòôõöúùûüçñzywk]/g, (c) => 'aaaaaeeeeiiiiooooouuuusnsivc'['áàâãäéèêëíìîïóòôõöúùûüçñzywk'.indexOf(c)])
    .replace(/[^a-z ]/g, '')
    .replace(/(.)\1/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function trigrams(s: string): Set<string> {
  const out = new Set<string>()
  for (const w of s.split(/[^a-z0-9]+/).filter(Boolean)) {
    const p = `  ${w} `
    for (let i = 0; i + 3 <= p.length; i++) out.add(p.slice(i, i + 3))
  }
  return out
}

export function nameSimilarity(a: string, b: string): number {
  const ta = trigrams(nameKey(a))
  const tb = trigrams(nameKey(b))
  if (ta.size === 0 && tb.size === 0) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / (ta.size + tb.size - inter)
}

// ---------------------------------------------------------------- plan
export interface ExistingClient {
  id?: string
  name: string
  phone_e164: string | null
  external_code: string | null
}

export type RowStatus = 'create' | 'match' | 'skip'

export interface PlannedRow {
  /** Line in the file (the header is line 1). */
  line: number
  status: RowStatus
  name: string
  phone: string | null
  externalCode: string | null
  birthday: string | null
  notes: string | null
  warnings: string[]
  /** No phone and no code: the server cannot match it, so the plan matches by exact name and the row is not sent. */
  viaName?: boolean
}

export interface ImportPlan {
  rows: PlannedRow[]
  totals: { rows: number; create: number; match: number; warnings: number; skipped: number }
  missing: Field[]
}

function findMatch(pool: ExistingClient[], name: string, phone: string | null, code: string | null): boolean {
  if (code && pool.some((c) => c.external_code === code)) return true
  if (!phone) return false
  return pool.some(
    (c) => c.phone_e164 === phone && (c.external_code === null || code === null) && nameSimilarity(c.name, name) >= 0.82,
  )
}

/** Turns parsed rows into planned rows, simulating the server-side match against `existing` and earlier rows. */
export function planImport(parsed: ParsedCsv, existing: ExistingClient[]): ImportPlan {
  const map = matchHeaders(parsed.headers)
  const rows: PlannedRow[] = []
  if (map.missing.length > 0) return { rows, totals: { rows: 0, create: 0, match: 0, warnings: 0, skipped: 0 }, missing: map.missing }

  const pool: ExistingClient[] = [...existing]
  const cell = (r: string[], f: Field) => (map.index[f] === undefined ? '' : (r[map.index[f]!] ?? '').trim())

  parsed.rows.forEach((r, i) => {
    const warnings: string[] = []
    const name = cell(r, 'name').replace(/\s+/g, ' ')
    const base = { line: i + 2, name, warnings }
    if (!name) {
      rows.push({ ...base, status: 'skip', phone: null, externalCode: null, birthday: null, notes: null, warnings: ['Nome em branco'] })
      return
    }

    const rawPhone = cell(r, 'phone')
    let phone: string | null = null
    if (rawPhone) {
      phone = normalizePhone(rawPhone)
      if (!phone) warnings.push(`Telefone inválido (${rawPhone}): importada sem telefone`)
    }

    const rawBday = cell(r, 'birthday')
    const birthday = parseBirthday(rawBday)
    if (rawBday && !birthday) warnings.push(`Aniversário inválido (${rawBday}): ignorado`)

    let notes = cell(r, 'notes') || null
    const rawCredit = cell(r, 'credit')
    if (rawCredit) {
      const cents = parseCreditCents(rawCredit)
      if (cents === null) warnings.push(`Crédito inválido (${rawCredit}): ignorado`)
      else if (cents > 0) notes = notes ? `${notes}\n${creditNote(cents)}` : creditNote(cents)
    }

    const externalCode = cell(r, 'external_code') || null
    const viaName = !phone && !externalCode
    const matched = viaName
      ? pool.some((c) => c.phone_e164 === null && nameKey(c.name) === nameKey(name))
      : findMatch(pool, name, phone, externalCode)
    const status: RowStatus = matched ? 'match' : 'create'
    if (status === 'create') pool.push({ name, phone_e164: phone, external_code: externalCode })
    rows.push({ ...base, status, phone, externalCode, birthday, notes, ...(viaName && matched ? { viaName: true } : {}) })
  })

  return {
    rows,
    totals: {
      rows: rows.length,
      create: rows.filter((r) => r.status === 'create').length,
      match: rows.filter((r) => r.status === 'match').length,
      warnings: rows.filter((r) => r.warnings.length > 0 && r.status !== 'skip').length,
      skipped: rows.filter((r) => r.status === 'skip').length,
    },
    missing: [],
  }
}

// ---------------------------------------------------------------- run
export interface UpsertArgs {
  p_name: string
  p_phone: string | null
  p_external_code: string | null
  p_birthday: string | null
  p_notes: string | null
}

export interface RunResult {
  created: number
  matched: number
  skipped: number
  errors: Array<{ line: number; name: string; message: string }>
}

export const CHUNK_SIZE = 25

/**
 * Sequential upserts in chunks. A row is "created" when the returned id is neither in `existingIds`
 * nor already returned earlier in this run; otherwise it is "matched".
 */
export async function runImport(
  plan: ImportPlan,
  upsert: (a: UpsertArgs) => Promise<string>,
  existingIds: ReadonlySet<string>,
  onProgress?: (done: number, total: number) => void,
  chunkSize = CHUNK_SIZE,
): Promise<RunResult> {
  const result: RunResult = { created: 0, matched: 0, skipped: plan.totals.skipped, errors: [] }
  const todo = plan.rows.filter((r) => r.status !== 'skip')
  const seen = new Set(existingIds)
  let done = 0
  onProgress?.(0, todo.length)
  for (let i = 0; i < todo.length; i += chunkSize) {
    for (const r of todo.slice(i, i + chunkSize)) {
      if (r.viaName) {
        result.matched++
        done++
        continue
      }
      try {
        const id = await upsert({
          p_name: r.name,
          p_phone: r.phone,
          p_external_code: r.externalCode,
          p_birthday: r.birthday,
          p_notes: r.notes,
        })
        if (seen.has(id)) result.matched++
        else result.created++
        seen.add(id)
      } catch (e) {
        result.errors.push({ line: r.line, name: r.name, message: e instanceof Error ? e.message : String(e) })
      }
      done++
    }
    onProgress?.(done, todo.length)
    await new Promise((res) => setTimeout(res, 0)) // let the progress bar paint between chunks
  }
  return result
}

export function errorsToCsv(errors: RunResult['errors']): string {
  return Papa.unparse({ fields: ['linha', 'nome', 'erro'], data: errors.map((e) => [e.line, e.name, e.message]) })
}
