// Reads for CRM and packages (react-query). Writes go through src/lib/rpc.ts; then call invalidateAll().
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { Database } from '../types/db'
import { APPT_SELECT, fail, type AppointmentRow } from './queries'
import { rpc, supabase } from './rpc'

export type ClientDirRow = Database['public']['Functions']['rpc_search_clients']['Returns'][number]
export type PackageTemplate = Database['public']['Tables']['package_templates']['Row']

export interface ClientContext {
  client_id: string
  name: string
  phone_e164: string | null
  segment: 'nova' | 'ativa' | 'inativa'
  needs_return: boolean
  last_visit_at: string | null
  visit_count: number
  /** Present only for the owner (and the agent): the database omits it for professionals. */
  total_spent_cents?: number
  preferred_professional_id: string | null
  professional_ranking: Array<{ professional_id: string; visits: number }>
  active_packages: Array<{ client_package_id: string; template_name: string; service_id: string; remaining: number; expires_at: string }>
  next_appointments: Array<{ id: string; starts_at: string; professional_id: string; service_name: string; status: string }>
}

export const CLIENT_PAGE = 50
export const HISTORY_PAGE = 20

/** Directory search: pages of 50; the total comes from the first row's total_count. */
export function useClientDirectory(query: string, filter: string) {
  return useInfiniteQuery({
    queryKey: ['clients-search', 'dir', query, filter],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      rpc.searchClients({ p_query: query.trim() || null, p_filter: filter, p_limit: CLIENT_PAGE, p_offset: pageParam }),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.length, 0)
      const total = last[0]?.total_count ?? 0
      return loaded < total ? loaded : undefined
    },
  })
}

/** Owner only: one call for the visible ids. */
export function useClientSpend(ids: string[], enabled: boolean) {
  return useQuery({
    queryKey: ['client-spend', [...ids].sort().join(',')],
    enabled: enabled && ids.length > 0,
    queryFn: async () => {
      const rows = await rpc.clientSpend({ p_client_ids: ids })
      return new Map(rows.map((r) => [r.client_id, Number(r.total_spent_cents)]))
    },
  })
}

export function useNeedsReturnCount() {
  return useQuery({
    queryKey: ['needs-return', 'count'],
    queryFn: async () =>
      (await rpc.searchClients({ p_query: null, p_filter: 'needs_return', p_limit: 1, p_offset: 0 }))[0]?.total_count ?? 0,
  })
}

export function useClientRow(id: string | undefined) {
  return useQuery({
    queryKey: ['client-row', id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase.from('clients').select('*').eq('id', id!).maybeSingle()
      fail(error)
      return data
    },
  })
}

export function useClientContext(id: string | undefined) {
  return useQuery({
    queryKey: ['client-context', id],
    enabled: !!id,
    queryFn: async () => (await rpc.getClientContext({ p_client_id: id! })) as unknown as ClientContext,
  })
}

export function useClientUpcoming(id: string | undefined) {
  return useQuery({
    queryKey: ['client-appts', id, 'upcoming'],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('appointments')
        .select(APPT_SELECT)
        .eq('client_id', id!)
        .in('status', ['scheduled', 'confirmed'])
        .gte('starts_at', new Date().toISOString())
        .order('starts_at')
      fail(error)
      return (data ?? []) as unknown as AppointmentRow[]
    },
  })
}

/** All statuses, newest first, 20 per page. */
export function useClientHistory(id: string | undefined) {
  return useInfiniteQuery({
    queryKey: ['client-appts', id, 'history'],
    enabled: !!id,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const { data, error } = await supabase
        .from('appointments')
        .select(APPT_SELECT)
        .eq('client_id', id!)
        .order('starts_at', { ascending: false })
        .range(pageParam, pageParam + HISTORY_PAGE - 1)
      fail(error)
      return (data ?? []) as unknown as AppointmentRow[]
    },
    getNextPageParam: (last, all) => (last.length === HISTORY_PAGE ? all.length * HISTORY_PAGE : undefined),
  })
}

export interface PackageRow {
  client_package_id: string
  client_id: string
  template_name: string
  service_id: string
  sessions_total: number
  remaining: number
  expires_at: string
  status: 'active' | 'expired' | 'exhausted'
}

function toPackageRow(r: Database['public']['Views']['v_client_packages']['Row']): PackageRow {
  return {
    client_package_id: r.client_package_id ?? '',
    client_id: r.client_id ?? '',
    template_name: r.template_name ?? '',
    service_id: r.service_id ?? '',
    sessions_total: r.sessions_total ?? 0,
    remaining: r.remaining ?? 0,
    expires_at: r.expires_at ?? '',
    status: (r.status ?? 'active') as PackageRow['status'],
  }
}

/** Packages of one client (voided ones are not listed by the view). */
export function useClientPackages(clientId: string | null | undefined) {
  return useQuery({
    queryKey: ['packages', 'client', clientId],
    enabled: !!clientId,
    queryFn: async () => {
      const { data, error } = await supabase.from('v_client_packages').select('*').eq('client_id', clientId!).order('expires_at')
      fail(error)
      return (data ?? []).map(toPackageRow)
    },
  })
}

/** Every package in the studio with the client name (two queries: the view has no client name). */
export function useAllPackages() {
  return useQuery({
    queryKey: ['packages', 'all'],
    queryFn: async () => {
      const { data, error } = await supabase.from('v_client_packages').select('*').order('expires_at')
      fail(error)
      const rows = (data ?? []).map(toPackageRow)
      const ids = [...new Set(rows.map((r) => r.client_id))]
      const names = new Map<string, string>()
      for (let i = 0; i < ids.length; i += 100) {
        const res = await supabase.from('clients').select('id,name').in('id', ids.slice(i, i + 100))
        fail(res.error)
        for (const c of res.data ?? []) names.set(c.id, c.name)
      }
      return rows.map((r) => ({ ...r, client_name: names.get(r.client_id) ?? '' }))
    },
  })
}

export function usePackageTemplates() {
  return useQuery({
    queryKey: ['package-templates'],
    queryFn: async () => {
      const { data, error } = await supabase.from('package_templates').select('*').order('name')
      fail(error)
      return (data ?? []) as PackageTemplate[]
    },
  })
}

/** Session position of an appointment inside its package: X = rank among the package's non-cancelled/no_show appointments by starts_at. */
export function usePackageSession(appointmentId: string, packageId: string | null | undefined) {
  return useQuery({
    queryKey: ['package-sessions', packageId],
    enabled: !!packageId,
    staleTime: 30_000,
    queryFn: async () => {
      const [appts, pkg] = await Promise.all([
        supabase
          .from('appointments')
          .select('id,starts_at,status')
          .eq('client_package_id', packageId!)
          .not('status', 'in', '(cancelled,no_show)')
          .order('starts_at'),
        supabase.from('client_packages').select('sessions_total').eq('id', packageId!).maybeSingle(),
      ])
      fail(appts.error)
      fail(pkg.error)
      return { ids: (appts.data ?? []).map((a) => a.id), total: pkg.data?.sessions_total ?? 0 }
    },
    select: (d) => {
      const i = d.ids.indexOf(appointmentId)
      return i < 0 ? null : { position: i + 1, total: d.total }
    },
  })
}
