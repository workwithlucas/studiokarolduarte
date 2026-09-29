// End-to-end flow against the LOCAL Supabase, through the same src/lib/rpc.ts wrappers the UI uses.
// Needs: supabase start, npm run dev:users. Prints failures and a one-line summary only.
import { ymdOf, addDaysYMD, todaySP } from '../src/lib/datetime'
import { rpc, RpcError, supabase, type ErrorCode } from '../src/lib/rpc'

const PASSWORD = 'studio-dev-123'
let passed = 0
const failures: string[] = []

function check(name: string, ok: boolean, extra = '') {
  if (ok) passed++
  else failures.push(`${name}${extra ? ` (${extra})` : ''}`)
}

async function expectCode(name: string, code: ErrorCode, fn: () => Promise<unknown>) {
  try {
    await fn()
    check(name, false, `esperava ${code}, mas não houve erro`)
  } catch (e) {
    const got = e instanceof RpcError ? e.code : String(e)
    check(name, got === code, `esperava ${code}, veio ${got}`)
  }
}

async function login(email: string) {
  await supabase.auth.signOut()
  const { error } = await supabase.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`login ${email}: ${error.message}`)
}

async function statusOf(id: string): Promise<string | undefined> {
  const { data } = await supabase.from('appointments').select('status').eq('id', id).maybeSingle()
  return data?.status
}

async function main() {
  await login('karol@studio.test')

  const { data: pros } = await supabase.from('professionals').select('id,name')
  const mara = pros?.find((p) => p.name === 'Mara')
  if (!mara) throw new Error('professional Mara not found (supabase db reset + npm run dev:users)')

  // ---- fixtures (idempotent: reuse by name)
  const { data: svcRows } = await supabase.from('services').select('id').eq('name', 'ZZ Teste de fluxo')
  const svcId = await rpc.upsertService({
    p_id: svcRows?.[0]?.id ?? null,
    p_name: 'ZZ Teste de fluxo',
    p_category: 'outros',
    p_kind: 'standard',
    p_duration_min: 60,
    p_price_cents: 5000,
    p_maintenance_duration_min: null,
    p_maintenance_price_cents: null,
    p_cash_price_cents: null,
    p_active: true,
  })
  const { data: links } = await supabase.from('professional_services').select('service_id').eq('professional_id', mara.id)
  await rpc.setProfessionalServices({
    p_professional_id: mara.id,
    p_service_ids: [...new Set([...(links ?? []).map((l) => l.service_id), svcId])],
  })

  const clientId = await rpc.upsertClient({
    p_name: 'ZZ Cliente Fluxo',
    p_phone: '11 95555-0001',
    p_external_code: null,
    p_birthday: null,
    p_notes: null,
  })
  check('create client', !!clientId)

  const today = todaySP()
  const avail = await rpc.getAvailability({
    p_professional_id: mara.id,
    p_service_id: svcId,
    p_action: 'placement',
    p_addon_ids: [],
    p_from: addDaysYMD(today, 3),
    p_to: addDaysYMD(today, 12),
    p_source: 'staff',
  })
  const firstOfDay = new Map<string, string>()
  for (const s of avail) {
    const d = ymdOf(s.starts_at)
    if (!firstOfDay.has(d)) firstOfDay.set(d, s.starts_at)
  }
  const [d1, d2, d3] = [...firstOfDay.values()]
  if (!d1 || !d2 || !d3) throw new Error('not enough free days for the flow (need working hours for Mara)')

  const book = (startsAt: string) =>
    rpc.bookAppointment({
      p_client_id: clientId,
      p_professional_id: mara.id,
      p_service_id: svcId,
      p_action: 'placement',
      p_addon_ids: [],
      p_starts_at: startsAt,
      p_source: 'staff',
      p_idempotency_key: crypto.randomUUID(),
      p_notes: null,
    })

  // ---- book, select, reschedule, confirm, cancel x2
  const a = await book(d1)
  const { data: sel } = await supabase
    .from('appointments')
    .select('id, client:clients(name), service:services(name), professional:professionals(name)')
    .eq('id', a)
    .maybeSingle()
  check('book: appears in select with joins', sel?.id === a && !!sel.client && !!sel.service && !!sel.professional)

  await rpc.rescheduleAppointment({ p_appointment_id: a, p_new_starts_at: d2, p_new_professional_id: null, p_force: false })
  const { data: moved } = await supabase.from('appointments').select('starts_at').eq('id', a).maybeSingle()
  check('reschedule moves the appointment', !!moved && Date.parse(moved.starts_at) === Date.parse(d2))

  await rpc.confirmAppointment({ p_appointment_id: a })
  check('confirm -> confirmed', (await statusOf(a)) === 'confirmed')

  await rpc.cancelAppointment({ p_appointment_id: a, p_reason: 'Cliente cancelou' })
  check('cancel -> cancelled', (await statusOf(a)) === 'cancelled')
  let second = true
  try {
    await rpc.cancelAppointment({ p_appointment_id: a, p_reason: 'Outro' })
  } catch {
    second = false
  }
  check('second cancel is OK', second)

  // ---- complete with null end
  const c = await book(d1)
  await rpc.completeAppointment({ p_appointment_id: c, p_actual_end: null })
  check('complete with null end', (await statusOf(c)) === 'completed')

  // ---- block + BLOCK_CONFLICT
  const b = await book(d3)
  const bStart = d3
  const bEnd = new Date(Date.parse(d3) + 60 * 60_000).toISOString()
  await expectCode('block over appointment -> BLOCK_CONFLICT', 'BLOCK_CONFLICT', () =>
    rpc.createBlock({ p_professional_id: mara.id, p_starts_at: bStart, p_ends_at: bEnd, p_reason: 'Teste', p_allow_conflicts: false }),
  )
  const blockId = await rpc.createBlock({
    p_professional_id: mara.id,
    p_starts_at: bStart,
    p_ends_at: bEnd,
    p_reason: 'Teste',
    p_allow_conflicts: true,
  })
  const { data: blk } = await supabase.from('schedule_blocks').select('id').eq('id', blockId).maybeSingle()
  check('block with allow_conflicts is created', blk?.id === blockId)
  await rpc.deleteBlock({ p_block_id: blockId })
  const { data: gone } = await supabase.from('schedule_blocks').select('id').eq('id', blockId).maybeSingle()
  check('block deleted', gone === null)

  // ---- rpc_upsert_professional
  const { data: zz } = await supabase.from('professionals').select('id').eq('name', 'ZZ Fluxo Profissional')
  const zzId = await rpc.upsertProfessional({ p_id: zz?.[0]?.id ?? null, p_name: 'ZZ Fluxo Profissional', p_color: '#7C8FB5', p_active: true })
  check('owner: upsert_professional', !!zzId)
  await rpc.upsertProfessional({ p_id: zzId, p_name: 'ZZ Fluxo Profissional', p_color: '#7C8FB5', p_active: false })
  const { data: zzRow } = await supabase.from('professionals').select('active').eq('id', zzId).maybeSingle()
  check('owner: deactivate without usage', zzRow?.active === false)

  await expectCode('deactivate with future appointment -> HAS_USAGE', 'HAS_USAGE', () =>
    rpc.upsertProfessional({ p_id: mara.id, p_name: 'Mara', p_color: null, p_active: false }),
  )

  await login('mara@studio.test')
  await expectCode('mara: upsert_professional -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.upsertProfessional({ p_id: null, p_name: 'Intrusa', p_color: null, p_active: true }),
  )

  // ---- cleanup + invariants
  await login('karol@studio.test')
  await rpc.cancelAppointment({ p_appointment_id: b, p_reason: 'Outro' })
  await rpc.upsertService({
    p_id: svcId,
    p_name: 'ZZ Teste de fluxo',
    p_category: 'outros',
    p_kind: 'standard',
    p_duration_min: 60,
    p_price_cents: 5000,
    p_maintenance_duration_min: null,
    p_maintenance_price_cents: null,
    p_cash_price_cents: null,
    p_active: false,
  })
  const inv = await supabase.rpc('check_invariants')
  check('check_invariants() = 0 rows', !inv.error && (inv.data ?? []).length === 0, inv.error?.message ?? JSON.stringify(inv.data))
}

main()
  .catch((e) => failures.push(`erro inesperado: ${e instanceof Error ? e.message : String(e)}`))
  .finally(async () => {
    await supabase.auth.signOut()
    for (const f of failures) console.log(`FAIL ${f}`)
    console.log(`test:flow ${failures.length === 0 ? 'PASS' : 'FAIL'} (${passed} ok, ${failures.length} falhas)`)
    process.exit(failures.length === 0 ? 0 : 1)
  })
