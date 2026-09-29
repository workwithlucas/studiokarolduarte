// End-to-end flow against the LOCAL Supabase, through the same src/lib/rpc.ts wrappers the UI uses.
// Needs: supabase start, npm run dev:users. Prints failures and a one-line summary only.
import { ymdOf, addDaysYMD, todaySP } from '../src/lib/datetime'
import { readFileSync } from 'node:fs'
import { decodeCsv, parseCsv, planImport, runImport } from '../src/lib/import/clients'
import { fetchAppointmentKeys, fetchExistingClients, fetchImportContext } from '../src/lib/import/existing'
import { parseAppointmentFile, planAppointments, runAppointmentImport } from '../src/lib/import/appointments'
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

async function importFixture(): Promise<{ created: number; matched: number; errors: number }> {
  const text = decodeCsv(readFileSync('tests/fixtures/clients-sample.csv'))
  const existing = await fetchExistingClients()
  const plan = planImport(parseCsv(text), existing)
  const r = await runImport(plan, (a) => rpc.upsertClient(a), new Set(existing.map((c) => c.id)))
  return { created: r.created, matched: r.matched, errors: r.errors.length }
}

/** Packages, import and money visibility. Starts and ends logged in as Karol. */
async function crmFlow(maraId: string) {
  // ---- package template + client + sale
  const { data: tplRows } = await supabase.from('package_templates').select('id').eq('name', 'ZZ Modelo Fluxo')
  const { data: svcRows } = await supabase.from('services').select('id').eq('name', 'ZZ Pacote Fluxo')
  const svcId = await rpc.upsertService({
    p_id: svcRows?.[0]?.id ?? null,
    p_name: 'ZZ Pacote Fluxo',
    p_category: 'outros',
    p_kind: 'standard',
    p_duration_min: 30,
    p_price_cents: 4000,
    p_maintenance_duration_min: null,
    p_maintenance_price_cents: null,
    p_cash_price_cents: null,
    p_active: true,
  })
  const { data: links } = await supabase.from('professional_services').select('service_id').eq('professional_id', maraId)
  await rpc.setProfessionalServices({
    p_professional_id: maraId,
    p_service_ids: [...new Set([...(links ?? []).map((l) => l.service_id), svcId])],
  })
  const tplId = await rpc.upsertPackageTemplate({
    p_id: tplRows?.[0]?.id ?? null,
    p_name: 'ZZ Modelo Fluxo',
    p_service_id: svcId,
    p_sessions_total: 3,
    p_validity_days: 60,
    p_price_cents: 9000,
    p_active: true,
  })
  check('owner: create package template', !!tplId)

  const clientId = await rpc.upsertClient({ p_name: 'ZZ Cliente Pacote', p_phone: '11 95555-0002', p_external_code: null, p_birthday: null, p_notes: null })
  const pkgId = await rpc.sellPackage({ p_client_id: clientId, p_template_id: tplId })
  const remaining = async (id: string) =>
    (await supabase.from('v_client_packages').select('remaining').eq('client_package_id', id).maybeSingle()).data?.remaining
  check('sell package: 3 remaining', (await remaining(pkgId)) === 3)

  const today = todaySP()
  const avail = await rpc.getAvailability({
    p_professional_id: maraId,
    p_service_id: svcId,
    p_action: 'placement',
    p_addon_ids: [],
    p_from: addDaysYMD(today, 3),
    p_to: addDaysYMD(today, 20),
    p_source: 'staff',
  })
  const firstOfDay = new Map<string, string>()
  for (const s of avail) {
    const d = ymdOf(s.starts_at)
    if (!firstOfDay.has(d)) firstOfDay.set(d, s.starts_at)
  }
  const days = [...firstOfDay.values()]
  if (days.length < 4) throw new Error('not enough free days for the package flow')

  const bookPkg = (startsAt: string) =>
    rpc.bookAppointment({
      p_client_id: clientId,
      p_professional_id: maraId,
      p_service_id: svcId,
      p_action: 'placement',
      p_addon_ids: [],
      p_starts_at: startsAt,
      p_source: 'staff',
      p_idempotency_key: crypto.randomUUID(),
      p_notes: null,
      p_client_package_id: pkgId,
    })
  const booked = [await bookPkg(days[0]!), await bookPkg(days[1]!), await bookPkg(days[2]!)]
  check('3 package bookings: 0 remaining', (await remaining(pkgId)) === 0)
  const { data: priced } = await supabase.from('appointments').select('price_cents').eq('id', booked[0]!).maybeSingle()
  check('package appointment costs 0', priced?.price_cents === 0)
  await expectCode('4th booking -> PACKAGE_EMPTY', 'PACKAGE_EMPTY', () => bookPkg(days[3]!))
  await rpc.cancelAppointment({ p_appointment_id: booked[2]!, p_reason: 'Outro' })
  check('cancel one: remaining +1', (await remaining(pkgId)) === 1)
  await expectCode('void package with usage -> HAS_USAGE', 'HAS_USAGE', () => rpc.voidPackage({ p_client_package_id: pkgId }))

  // ---- import: idempotent, families, spelling variants
  const first = await importFixture()
  check('import: no errors', first.errors === 0, JSON.stringify(first))
  const second = await importFixture()
  check('import twice: second run creates 0', second.created === 0 && second.errors === 0, JSON.stringify(second))
  const family = await supabase.from('clients').select('id').eq('phone_e164', '5511981110001').like('name', 'ZZ%')
  check('mother/daughter: 2 clients', family.data?.length === 2, String(family.data?.length))
  const tere = await supabase.from('clients').select('id').eq('phone_e164', '5511982220002').like('name', 'ZZ%')
  check('Terezinha/Teresinha: 1 client', tere.data?.length === 1, String(tere.data?.length))

  // ---- owner sees spend
  const spend = await rpc.clientSpend({ p_client_ids: [clientId] })
  check('owner: rpc_client_spend works', spend.length === 1)
  const ownerCtx = (await rpc.getClientContext({ p_client_id: clientId })) as Record<string, unknown>
  check('owner: context has total_spent_cents', typeof ownerCtx.total_spent_cents === 'number')

  // ---- Mara: search, no spend, sell, no void
  await login('mara@studio.test')
  const found = await rpc.searchClients({ p_query: 'zz cliente pacote', p_filter: 'all', p_limit: 5, p_offset: 0 })
  check('mara: search works', found.some((c) => c.client_id === clientId))
  const accent = await rpc.searchClients({ p_query: 'joao batista', p_filter: 'all', p_limit: 5, p_offset: 0 })
  check('mara: accent-insensitive search', accent.some((c) => c.name === 'ZZ João Batista Lima'))
  const maraCtx = (await rpc.getClientContext({ p_client_id: clientId })) as Record<string, unknown>
  check('mara: context omits spend', !('total_spent_cents' in maraCtx))
  await expectCode('mara: rpc_client_spend -> FORBIDDEN', 'FORBIDDEN', () => rpc.clientSpend({ p_client_ids: [clientId] }))
  const stats = await supabase.from('v_client_stats').select('client_id').limit(1)
  check('mara: v_client_stats denied', !!stats.error)
  const maraPkg = await rpc.sellPackage({ p_client_id: clientId, p_template_id: tplId })
  check('mara: sell package works', !!maraPkg)
  await expectCode('mara: void package -> FORBIDDEN', 'FORBIDDEN', () => rpc.voidPackage({ p_client_package_id: maraPkg }))

  // ---- cleanup (owner)
  await login('karol@studio.test')
  await rpc.voidPackage({ p_client_package_id: maraPkg })
  for (const id of booked.slice(0, 2)) await rpc.cancelAppointment({ p_appointment_id: id, p_reason: 'Outro' })
}

/** Appointment import: idempotent, overlap skipped, one live ledger entry each. Owner. Cancels what it creates. */
async function appointmentImportFlow(maraId: string) {
  const upsert = async (name: string, kind: 'standard' | 'removal', dur: number, price: number, mDur: number | null, mPrice: number | null) => {
    const { data } = await supabase.from('services').select('id').eq('name', name)
    return rpc.upsertService({
      p_id: data?.[0]?.id ?? null,
      p_name: name,
      p_category: 'outros',
      p_kind: kind,
      p_duration_min: dur,
      p_price_cents: price,
      p_maintenance_duration_min: mDur,
      p_maintenance_price_cents: mPrice,
      p_cash_price_cents: null,
      p_active: true,
    })
  }
  const svc = await upsert('ZZ Import Serviço', 'standard', 60, 5000, 45, 3000)
  const rem = await upsert('ZZ Import Remoção', 'removal', 30, 2000, null, null)
  const { data: links } = await supabase.from('professional_services').select('service_id').eq('professional_id', maraId)
  await rpc.setProfessionalServices({
    p_professional_id: maraId,
    p_service_ids: [...new Set([...(links ?? []).map((l) => l.service_id), svc, rem])],
  })

  // Unique year per run so a re-run of this test does not hit the previous run's idempotency keys.
  const year = 2040 + Math.floor(Math.random() * 60)
  const text = readFileSync('tests/fixtures/appointments-sample.csv', 'utf-8').replaceAll('/2031;', `/${year};`)
  const buf = new TextEncoder().encode(text)
  const sheet = await parseAppointmentFile('appointments-sample.csv', buf.buffer as ArrayBuffer)

  const runOnce = async () => {
    const plan = planAppointments(sheet, await fetchImportContext())
    return { plan, result: await runAppointmentImport(plan, { upsertClient: (a) => rpc.upsertClient(a), book: (a) => rpc.bookAppointment(a), existingKeys: await fetchAppointmentKeys() }) }
  }
  const first = await runOnce()
  check('appt import: 8 created', first.result.created === 8, JSON.stringify({ c: first.result.created, e: first.result.errors, s: first.result.skipped.map((s) => s.reason) }))
  check('appt import: no errors', first.result.errors.length === 0, JSON.stringify(first.result.errors))
  check('appt import: overlapping row skipped', first.result.skipped.some((s) => /SLOT_TAKEN/.test(s.reason) && s.client === 'ZZ Imp Gabi'))
  check('appt import: unknown service and professional skipped, none created', first.plan.skipped.length === 4)

  const { data: imported } = await supabase
    .from('appointments')
    .select('id,status,client:clients(name)')
    .eq('professional_id', maraId)
    .gte('starts_at', `${year}-01-01T00:00:00-03:00`)
    .lt('starts_at', `${year + 1}-01-01T00:00:00-03:00`)
  const ids = (imported ?? []).map((a) => a.id)
  check('appt import: 8 appointments in the agenda', ids.length === 8, String(ids.length))
  const { data: live } = await supabase.from('ledger_entries').select('appointment_id').in('appointment_id', ids).is('voided_at', null)
  const perAppt = new Map<string, number>()
  for (const l of live ?? []) perAppt.set(l.appointment_id!, (perAppt.get(l.appointment_id!) ?? 0) + 1)
  check('appt import: one live ledger entry per appointment', ids.length > 0 && ids.every((id) => perAppt.get(id) === 1))

  const second = await runOnce()
  check('appt import twice: second run creates 0', second.result.created === 0 && second.result.errors.length === 0, JSON.stringify({ c: second.result.created, e: second.result.errors }))

  for (const id of ids) await rpc.cancelAppointment({ p_appointment_id: id, p_reason: 'Outro' })
  for (const id of [svc, rem]) {
    const { data } = await supabase.from('services').select('name,kind,duration_min,price_cents,maintenance_duration_min,maintenance_price_cents').eq('id', id).maybeSingle()
    if (data) {
      await rpc.upsertService({
        p_id: id,
        p_name: data.name,
        p_category: 'outros',
        p_kind: data.kind,
        p_duration_min: data.duration_min,
        p_price_cents: data.price_cents,
        p_maintenance_duration_min: data.maintenance_duration_min,
        p_maintenance_price_cents: data.maintenance_price_cents,
        p_cash_price_cents: null,
        p_active: false,
      })
    }
  }
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

  // ---- packages, import, money visibility
  await login('karol@studio.test')
  await crmFlow(mara.id)
  await login('karol@studio.test')
  await appointmentImportFlow(mara.id)

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
