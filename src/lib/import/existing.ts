import { supabase } from '../supabase'
import type { ExistingClient } from './clients'
import type { ImportContext } from './appointments'

/** All clients (staff SELECT), paged, for the preview's match simulation and created/matched counting. */
export async function fetchExistingClients(): Promise<Array<ExistingClient & { id: string }>> {
  const out: Array<ExistingClient & { id: string }> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('clients')
      .select('id,name,phone_e164,external_code')
      .order('created_at')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) return out
  }
}

/** Catalog, team, links and clients for the appointment import's match simulation. */
export async function fetchImportContext(): Promise<ImportContext> {
  const [svc, pros, links, clients] = await Promise.all([
    supabase
      .from('services')
      .select('id,name,kind,duration_min,price_cents,maintenance_duration_min,maintenance_price_cents,active'),
    supabase.from('professionals').select('id,name,active'),
    supabase.from('professional_services').select('professional_id,service_id'),
    fetchExistingClients(),
  ])
  for (const r of [svc, pros, links]) if (r.error) throw new Error(r.error.message)
  return {
    services: svc.data ?? [],
    professionals: pros.data ?? [],
    links: new Set((links.data ?? []).map((l) => `${l.professional_id}|${l.service_id}`)),
    clients,
  }
}

/** Idempotency keys of every appointment (staff SELECT), paged. Tells "created" from "already there". */
export async function fetchAppointmentKeys(): Promise<Set<string>> {
  const out = new Set<string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('appointments')
      .select('idempotency_key')
      .not('idempotency_key', 'is', null)
      .order('id')
      .range(from, from + 999)
    if (error) throw new Error(error.message)
    for (const r of data ?? []) if (r.idempotency_key) out.add(r.idempotency_key)
    if (!data || data.length < 1000) return out
  }
}
