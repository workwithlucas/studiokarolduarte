// Receivables CSV import (old "a receber"): plan (preview) and run. Pure logic: the UI and the flow test pass in the RPC.
// Clients are matched like rpc_upsert_client but never created: unmatched rows are skipped and listed.
import Papa from 'papaparse'
import { parseBRL } from '../money'
import { parseYMD, sha256Hex } from './appointments'
import { nameKey, nameSimilarity, normalizeHeader, normalizePhone, type ParsedCsv } from './clients'

export type Field = 'client' | 'due' | 'amount' | 'description' | 'phone'

const ALIASES: Record<Field, string[]> = {
  client: ['cliente', 'nome'],
  due: ['vencimento', 'data'],
  amount: ['valor'],
  description: ['descricao', 'obs'],
  phone: ['telefone', 'celular', 'whatsapp'],
}
const REQUIRED: Field[] = ['client', 'due', 'amount']

export interface HeaderMap {
  index: Partial<Record<Field, number>>
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
  return { index, missing: REQUIRED.filter((f) => index[f] === undefined) }
}

export interface KnownClient {
  id: string
  name: string
  phone_e164: string | null
}

export interface PlannedReceivable {
  line: number
  clientId: string
  clientName: string
  due: string
  amountCents: number
  description: string
  /** sha256(client_id|due|amount|description). */
  key: string
}

export interface SkippedReceivable {
  line: number
  client: string
  reason: string
}

export interface ReceivablePlan {
  rows: PlannedReceivable[]
  skipped: SkippedReceivable[]
  totals: { rows: number; toImport: number; skipped: number }
  missing: Field[]
}

export const DEFAULT_DESCRIPTION = 'A receber (importado)'

export const receivableKey = (clientId: string, due: string, amountCents: number, description: string) =>
  sha256Hex(`${clientId}|${due}|${amountCents}|${description}`)

type Match = { id: string } | { reason: string }

/** Phone + similar name first (as rpc_upsert_client); otherwise a single exact name, then a single best similar name. */
export function matchClient(pool: KnownClient[], name: string, phone: string | null): Match {
  if (phone) {
    const byPhone = pool.filter((c) => c.phone_e164 === phone && nameSimilarity(c.name, name) >= 0.82)
    if (byPhone.length === 1) return { id: byPhone[0]!.id }
  }
  const key = nameKey(name)
  const exact = pool.filter((c) => nameKey(c.name) === key)
  if (exact.length === 1) return { id: exact[0]!.id }
  if (exact.length > 1) return { reason: `Nome ambíguo (${exact.length} clientes)` }
  const scored = pool
    .map((c) => ({ c, s: nameSimilarity(c.name, name) }))
    .filter((x) => x.s >= 0.82)
    .sort((a, b) => b.s - a.s)
  if (scored.length === 0) return { reason: 'Cliente não encontrada' }
  if (scored.length > 1 && scored[0]!.s === scored[1]!.s) return { reason: 'Nome ambíguo' }
  return { id: scored[0]!.c.id }
}

export async function planReceivables(parsed: ParsedCsv, clients: KnownClient[]): Promise<ReceivablePlan> {
  const map = matchHeaders(parsed.headers)
  const rows: PlannedReceivable[] = []
  const skipped: SkippedReceivable[] = []
  if (map.missing.length > 0) return { rows, skipped, totals: { rows: 0, toImport: 0, skipped: 0 }, missing: map.missing }

  const cell = (r: string[], f: Field) => (map.index[f] === undefined ? '' : (r[map.index[f]!] ?? '').trim())
  for (const [i, r] of parsed.rows.entries()) {
    const line = i + 2
    const client = cell(r, 'client').replace(/\s+/g, ' ')
    const skip = (reason: string) => skipped.push({ line, client, reason })
    if (!client) {
      skip('Cliente em branco')
      continue
    }
    const due = parseYMD(cell(r, 'due'))
    if (!due) {
      skip(`Vencimento inválido (${cell(r, 'due') || 'vazio'})`)
      continue
    }
    const amount = parseBRL(cell(r, 'amount'))
    if (amount === null || amount <= 0) {
      skip(`Valor inválido (${cell(r, 'amount') || 'vazio'})`)
      continue
    }
    const rawPhone = cell(r, 'phone')
    const m = matchClient(clients, client, rawPhone ? normalizePhone(rawPhone) : null)
    if ('reason' in m) {
      skip(m.reason)
      continue
    }
    const description = cell(r, 'description') || DEFAULT_DESCRIPTION
    rows.push({
      line,
      clientId: m.id,
      clientName: client,
      due,
      amountCents: amount,
      description,
      key: await receivableKey(m.id, due, amount, description),
    })
  }
  return { rows, skipped, totals: { rows: parsed.rows.length, toImport: rows.length, skipped: skipped.length }, missing: [] }
}

export interface CreateArgs {
  p_kind: 'income'
  p_description: string
  p_category: null
  p_amount_cents: number
  p_due_date: string
  p_client_id: string
  p_professional_id: null
  p_pay_now: false
  p_method: null
  p_import_key: string
}

export interface ReceivableRunResult {
  created: number
  alreadyThere: number
  skipped: SkippedReceivable[]
  errors: Array<{ line: number; client: string; reason: string }>
}

export const CHUNK_SIZE = 25

/** Sequential, in chunks of 25. A row is "created" when its key was not in `existingKeys` and not seen earlier in this run. */
export async function runReceivableImport(
  plan: ReceivablePlan,
  create: (a: CreateArgs) => Promise<string>,
  existingKeys: ReadonlySet<string>,
  onProgress?: (done: number, total: number) => void,
  chunkSize = CHUNK_SIZE,
): Promise<ReceivableRunResult> {
  const result: ReceivableRunResult = { created: 0, alreadyThere: 0, skipped: [...plan.skipped], errors: [] }
  const seen = new Set(existingKeys)
  let done = 0
  onProgress?.(0, plan.rows.length)
  for (let i = 0; i < plan.rows.length; i += chunkSize) {
    for (const r of plan.rows.slice(i, i + chunkSize)) {
      try {
        await create({
          p_kind: 'income',
          p_description: r.description,
          p_category: null,
          p_amount_cents: r.amountCents,
          p_due_date: r.due,
          p_client_id: r.clientId,
          p_professional_id: null,
          p_pay_now: false,
          p_method: null,
          p_import_key: r.key,
        })
        if (seen.has(r.key)) result.alreadyThere++
        else result.created++
        seen.add(r.key)
      } catch (e) {
        result.errors.push({ line: r.line, client: r.clientName, reason: e instanceof Error ? e.message : String(e) })
      }
      done++
    }
    onProgress?.(done, plan.rows.length)
    await new Promise((res) => setTimeout(res, 0)) // let the progress bar paint between chunks
  }
  return result
}

/** Skipped rows and errors in one CSV (linha, cliente, tipo, motivo). */
export function receivableProblemsToCsv(result: Pick<ReceivableRunResult, 'skipped' | 'errors'>): string {
  const data = [
    ...result.skipped.map((s) => [s.line, s.client, 'ignorada', s.reason]),
    ...result.errors.map((s) => [s.line, s.client, 'erro', s.reason]),
  ].sort((a, b) => Number(a[0]) - Number(b[0]))
  return Papa.unparse({ fields: ['linha', 'cliente', 'tipo', 'motivo'], data })
}
