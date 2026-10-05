// Sends the fixed "horário alterado" WhatsApp after rpc_adjust_appointment_time. Called by the app (staff JWT).
// The caller only names a reschedule request; the text, phone and appointment come from the database.
import { isUuid } from '../_shared/gates.ts'
import { sendRescheduleNotice } from '../_shared/reschedule.ts'
import { buildDeps, json, serve } from '../_deno/runtime.ts'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => {
  const res = json(body, status)
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v)
  return res
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return reply({ error: 'method not allowed' }, 405)
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const deps = buildDeps()
  const { data, error } = await (deps.db as any).auth.getUser(token)
  if (error || !data?.user) return reply({ error: 'unauthorized' }, 401)
  // staff only: an active professional row linked to this user
  const pro = await deps.db.from('professionals').select('id').eq('user_id', data.user.id).eq('active', true).limit(1)
  if (!(pro as any).data?.length) return reply({ error: 'forbidden' }, 403)
  const body = (await req.json().catch(() => null)) as { request_id?: unknown } | null
  if (!isUuid(body?.request_id)) return reply({ error: 'request_id invalid' }, 400)
  try {
    const outcome = await sendRescheduleNotice(deps, body.request_id)
    deps.log('notify_reschedule', { outcome })
    return reply({ outcome })
  } catch (e) {
    deps.log('notify_reschedule_failed', { error: String(e instanceof Error ? e.message : e) })
    return reply({ outcome: 'failed' }, 502)
  }
})
