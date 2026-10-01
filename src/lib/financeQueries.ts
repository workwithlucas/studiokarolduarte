// Owner-only finance reads (react-query). Every money number comes from rpc_finance_* (v_ledger); writes go through src/lib/rpc.ts.
import { useQuery } from '@tanstack/react-query'
import type { Database } from '../types/db'
import { fail } from './queries'
import { rpc, supabase } from './rpc'

export type FinanceRow = Database['public']['Functions']['rpc_finance_list']['Returns'][number]
export type CommissionRule = Database['public']['Tables']['commission_rules']['Row']

/** Wide window for "everything of one client" reads. */
export const WIDE_FROM = '2000-01-01'
export const WIDE_TO = '2100-12-31'

export interface ListFilters {
  mode: 'receivable' | 'payable' | 'statement'
  from: string
  to: string
  status?: string | null
  professionalId?: string | null
  clientId?: string | null
  query?: string | null
  includeReversed?: boolean
  limit?: number
}

export function fetchFinanceList(f: ListFilters) {
  return rpc.financeList({
    p_mode: f.mode,
    p_from: f.from,
    p_to: f.to,
    p_status: f.status ?? null,
    p_professional_id: f.professionalId ?? null,
    p_client_id: f.clientId ?? null,
    p_query: f.query?.trim() || null,
    p_include_reversed: f.includeReversed ?? false,
    p_limit: f.limit ?? 200,
    p_offset: 0,
  })
}

export function useFinanceSummary(from: string, to: string, professionalId: string | null) {
  return useQuery({
    queryKey: ['finance-summary', from, to, professionalId],
    queryFn: () => rpc.financeSummary({ p_from: from, p_to: to, p_professional_id: professionalId }),
  })
}

export function useFinanceList(f: ListFilters, enabled = true) {
  return useQuery({
    queryKey: ['finance-list', f.mode, f.from, f.to, f.status ?? '', f.professionalId ?? '', f.clientId ?? '', f.query ?? '', f.includeReversed ?? false, f.limit ?? 200],
    enabled,
    queryFn: () => fetchFinanceList(f),
  })
}

/** Live entry (amount, discount, paid) of an appointment or of a package sale. */
export function useFinanceEntry(target: { appointmentId?: string | null; packageId?: string | null }, enabled = true) {
  const { appointmentId = null, packageId = null } = target
  return useQuery({
    queryKey: ['finance-entry', appointmentId, packageId],
    enabled: enabled && !!(appointmentId || packageId),
    queryFn: () => rpc.financeEntry({ p_appointment_id: appointmentId, p_client_package_id: packageId }),
  })
}

/** Owner only: credit balance, open debt, open entries and the last movements of one client. */
export function useClientAccount(clientId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['client-account', clientId],
    enabled: enabled && !!clientId,
    queryFn: () => rpc.getClientAccount({ p_client_id: clientId! }),
  })
}

/** Owner only: balance and debt for a set of ids (one call). */
export function useClientAccountSummary(ids: string[], enabled = true) {
  return useQuery({
    queryKey: ['client-account-summary', [...ids].sort().join(',')],
    enabled: enabled && ids.length > 0,
    queryFn: async () => {
      const rows = await rpc.clientAccountSummary({ p_client_ids: ids })
      return new Map(rows.map((r) => [r.client_id, { balance: Number(r.credit_balance_cents), debt: Number(r.open_debt_cents) }]))
    },
  })
}

export function useCommissionRules(enabled = true) {
  return useQuery({
    queryKey: ['commission-rules'],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase.from('commission_rules').select('*')
      fail(error)
      return data ?? []
    },
  })
}

/** Reverses every live payment of one entry (used when cancelling or marking no-show is blocked by HAS_PAYMENTS). */
export async function reversePaymentsOfEntry(entryId: string, clientId: string | null): Promise<number> {
  const rows = await fetchFinanceList({ mode: 'statement', from: WIDE_FROM, to: WIDE_TO, clientId, limit: 1000 })
  const mine = rows.filter((r) => r.entry_id === entryId && r.payment_id && !r.reversed_at)
  for (const r of mine) await rpc.reversePayment({ p_payment_id: r.payment_id })
  return mine.length
}
