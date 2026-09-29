// Reads (react-query). Writes go through src/lib/rpc.ts only; after a write, call invalidateAll().
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { Database } from '../types/db'
import { addDaysYMD, isoAtMinutes } from './datetime'
import { rpc, supabase } from './rpc'

type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row']

export type Professional = Row<'professionals'>
export type Service = Row<'services'>
export type Addon = Row<'service_addons'>
export type WorkingHour = Row<'working_hours'>
export type Block = Row<'schedule_blocks'>
export type ProfessionalService = Row<'professional_services'>
export type ClientRow = Row<'clients'>

export type AppointmentRow = Row<'appointments'> & {
  client: Pick<ClientRow, 'id' | 'name' | 'phone_e164'> | null
  service: Pick<Service, 'id' | 'name' | 'category' | 'kind'> | null
  professional: Pick<Professional, 'id' | 'name' | 'color'> | null
  addons: Array<{ addon_id: string; price_delta_cents: number; duration_delta_min: number; addon: { name: string } | null }>
}

const APPT_SELECT =
  '*, client:clients(id,name,phone_e164), service:services(id,name,category,kind), professional:professionals(id,name,color), addons:appointment_addons(addon_id,price_delta_cents,duration_delta_min,addon:service_addons(name))'

/** Cancelled and no_show are never drawn. */
const DRAWN: Array<AppointmentRow['status']> = ['scheduled', 'confirmed', 'completed']

export const keys = {
  professionals: ['professionals'] as const,
  services: ['services'] as const,
  addons: ['addons'] as const,
  workingHours: ['working_hours'] as const,
  professionalServices: ['professional_services'] as const,
}

function fail(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

export function useProfessionals() {
  return useQuery({
    queryKey: keys.professionals,
    queryFn: async () => {
      const { data, error } = await supabase.from('professionals').select('*').order('name')
      fail(error)
      return data ?? []
    },
  })
}

export function useServices() {
  return useQuery({
    queryKey: keys.services,
    queryFn: async () => {
      const { data, error } = await supabase.from('services').select('*').order('name')
      fail(error)
      return data ?? []
    },
  })
}

export function useAddons() {
  return useQuery({
    queryKey: keys.addons,
    queryFn: async () => {
      const { data, error } = await supabase.from('service_addons').select('*').order('name')
      fail(error)
      return data ?? []
    },
  })
}

export function useWorkingHours() {
  return useQuery({
    queryKey: keys.workingHours,
    queryFn: async () => {
      const { data, error } = await supabase.from('working_hours').select('*').order('start_time')
      fail(error)
      return data ?? []
    },
  })
}

export function useProfessionalServices() {
  return useQuery({
    queryKey: keys.professionalServices,
    queryFn: async () => {
      const { data, error } = await supabase.from('professional_services').select('*')
      fail(error)
      return data ?? []
    },
  })
}

/** Appointments whose start falls in [fromDate, toDate] (São Paulo dates, inclusive). */
export function useAppointments(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ['appointments', 'range', fromDate, toDate],
    queryFn: async () => {
      const from = isoAtMinutes(fromDate, 0)
      const to = isoAtMinutes(addDaysYMD(toDate, 1), 0)
      if (!from || !to) return []
      const { data, error } = await supabase
        .from('appointments')
        .select(APPT_SELECT)
        .in('status', DRAWN)
        .gte('starts_at', from)
        .lt('starts_at', to)
        .order('starts_at')
      fail(error)
      return (data ?? []) as unknown as AppointmentRow[]
    },
  })
}

/** Scheduled appointments from now on (A confirmar). */
export function useToConfirm() {
  return useQuery({
    queryKey: ['appointments', 'to-confirm'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('appointments')
        .select(APPT_SELECT)
        .eq('status', 'scheduled')
        .gte('starts_at', new Date().toISOString())
        .order('starts_at')
        .limit(300)
      fail(error)
      return (data ?? []) as unknown as AppointmentRow[]
    },
  })
}

export function useBlocks(fromDate: string, toDate: string) {
  return useQuery({
    queryKey: ['blocks', fromDate, toDate],
    queryFn: async () => {
      const from = isoAtMinutes(fromDate, 0)
      const to = isoAtMinutes(addDaysYMD(toDate, 1), 0)
      if (!from || !to) return []
      const { data, error } = await supabase
        .from('schedule_blocks')
        .select('*')
        .lt('starts_at', to)
        .gt('ends_at', from)
        .order('starts_at')
      fail(error)
      return data ?? []
    },
  })
}

export function invalidateAll(qc: QueryClient) {
  for (const k of ['appointments', 'blocks', 'client-context', 'clients-search', 'availability']) {
    void qc.invalidateQueries({ queryKey: [k] })
  }
}

export function invalidateCatalog(qc: QueryClient) {
  for (const k of [keys.services, keys.addons, keys.professionalServices, keys.workingHours, keys.professionals]) {
    void qc.invalidateQueries({ queryKey: k })
  }
}

/** Realtime on appointments and schedule_blocks; debounced 300ms; refetches the visible range. */
export function useAgendaRealtime() {
  const qc = useQueryClient()
  useEffect(() => {
    let t: number | undefined
    const refresh = () => {
      window.clearTimeout(t)
      t = window.setTimeout(() => {
        void qc.invalidateQueries({ queryKey: ['appointments'] })
        void qc.invalidateQueries({ queryKey: ['blocks'] })
        void qc.invalidateQueries({ queryKey: ['availability'] })
      }, 300)
    }
    const ch = supabase
      .channel('agenda-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'appointments' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_blocks' }, refresh)
      .subscribe()
    return () => {
      window.clearTimeout(t)
      void supabase.removeChannel(ch)
    }
  }, [qc])
}

export interface AvailabilityArgs {
  professionalId: string | null
  serviceId: string | null
  action: 'placement' | 'maintenance' | 'removal' | null
  addonIds: string[]
  from: string
  to: string
}

export function useAvailability(a: AvailabilityArgs) {
  const enabled = !!(a.professionalId && a.serviceId && a.action)
  return useQuery({
    queryKey: ['availability', a.professionalId, a.serviceId, a.action, [...a.addonIds].sort().join(','), a.from, a.to],
    enabled,
    staleTime: 0,
    queryFn: () =>
      rpc.getAvailability({
        p_professional_id: a.professionalId!,
        p_service_id: a.serviceId!,
        p_action: a.action!,
        p_addon_ids: a.addonIds,
        p_from: a.from,
        p_to: a.to,
        p_source: 'staff',
      }),
  })
}

export function useSuggestedProfessionals(clientId: string | null, serviceId: string | null) {
  return useQuery({
    queryKey: ['availability', 'suggest', clientId, serviceId],
    enabled: !!serviceId,
    staleTime: 0,
    queryFn: () =>
      rpc.suggestProfessionals({
        p_client_id: clientId ?? '00000000-0000-0000-0000-000000000000',
        p_service_id: serviceId!,
      }),
  })
}
