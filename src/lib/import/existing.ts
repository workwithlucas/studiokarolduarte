import { supabase } from '../supabase'
import type { ExistingClient } from './clients'

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
