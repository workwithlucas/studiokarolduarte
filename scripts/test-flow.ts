// End-to-end flow against the LOCAL Supabase, through the same src/lib/rpc.ts wrappers the UI uses.
// Needs: supabase start, npm run dev:users. Prints failures and a one-line summary only.
import { ymdOf, addDaysYMD, todaySP } from '../src/lib/datetime'
import { readFileSync } from 'node:fs'
import { decodeCsv, parseCsv, planImport, runImport } from '../src/lib/import/clients'
import { fetchAppointmentKeys, fetchExistingClients, fetchImportContext } from '../src/lib/import/existing'
import { planReceivables, runReceivableImport } from '../src/lib/import/receivables'
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

/** Client account (task 9): deposit, use credit on an appointment, settle debt with Permuta, Mara FORBIDDEN. Starts and ends as Karol. */
async function accountFlow(maraId: string) {
  const today = todaySP()
  const { data: svcRows } = await supabase.from('services').select('id').eq('name', 'ZZ Conta Fluxo')
  const svcId = await rpc.upsertService({
    p_id: svcRows?.[0]?.id ?? null,
    p_name: 'ZZ Conta Fluxo',
    p_category: 'unhas',
    p_kind: 'standard',
    p_duration_min: 30,
    p_price_cents: 5000,
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
  const tag = String(Date.now() % 100000000).padStart(8, '0')
  const clientId = await rpc.upsertClient({ p_name: `ZZ Conta Fluxo ${tag}`, p_phone: `11 9${tag}`, p_external_code: null, p_birthday: null, p_notes: null })

  // ---- deposit
  const depReq = crypto.randomUUID()
  const dep = await rpc.addClientCredit({ p_client_id: clientId, p_amount_cents: 20000, p_method: 'pix', p_note: 'ZZ deposito', p_request_id: depReq, p_opening: false, p_paid_at: null })
  const dep2 = await rpc.addClientCredit({ p_client_id: clientId, p_amount_cents: 20000, p_method: 'pix', p_note: 'ZZ deposito', p_request_id: depReq, p_opening: false, p_paid_at: null })
  check('account: deposit is idempotent', dep === dep2)
  let acct = await rpc.getClientAccount({ p_client_id: clientId })
  check('account: balance 200 after the deposit', acct.credit_balance_cents === 20000 && acct.open_debt_cents === 0, JSON.stringify(acct))
  check('account: deposit shows in movements', acct.movements.some((m) => m.type === 'deposit' && m.amount_cents === 20000))
  await expectCode('account: deposit with barter -> METHOD_NOT_ALLOWED', 'METHOD_NOT_ALLOWED', () =>
    rpc.addClientCredit({ p_client_id: clientId, p_amount_cents: 100, p_method: 'barter', p_note: null, p_request_id: crypto.randomUUID(), p_opening: false, p_paid_at: null }),
  )

  // ---- use credit on an appointment (credit + pix)
  const avail = await rpc.getAvailability({
    p_professional_id: maraId,
    p_service_id: svcId,
    p_action: 'placement',
    p_addon_ids: [],
    p_from: addDaysYMD(today, 3),
    p_to: addDaysYMD(today, 30),
    p_source: 'staff',
  })
  const slot = avail.at(-2) ?? avail.at(-1)
  if (!slot) throw new Error('no free slot for the account flow')
  const apptId = await rpc.bookAppointment({
    p_client_id: clientId,
    p_professional_id: maraId,
    p_service_id: svcId,
    p_action: 'placement',
    p_addon_ids: [],
    p_starts_at: slot.starts_at,
    p_source: 'staff',
    p_idempotency_key: crypto.randomUUID(),
    p_notes: null,
    p_client_package_id: null,
  })
  const paid = await rpc.completeAndPay({
    p_appointment_id: apptId,
    p_actual_end: null,
    p_discount_cents: null,
    p_payments: [
      { amount_cents: 3000, method: 'credit_balance' },
      { amount_cents: 2000, method: 'pix' },
    ],
    p_request_id: crypto.randomUUID(),
  })
  check('account: appointment paid with credit + pix', paid.status === 'paid' && paid.paid_cents === 5000, JSON.stringify(paid))
  acct = await rpc.getClientAccount({ p_client_id: clientId })
  check('account: balance 170 after using 30', acct.credit_balance_cents === 17000, String(acct.credit_balance_cents))
  await expectCode('account: credit above the balance -> CREDIT_INSUFFICIENT', 'CREDIT_INSUFFICIENT', async () => {
    const e = await rpc.createManualEntry({
      p_kind: 'income', p_description: 'ZZ Conta acima', p_category: null, p_amount_cents: 30000, p_due_date: addDaysYMD(today, -1),
      p_client_id: clientId, p_professional_id: null, p_pay_now: false, p_method: null, p_import_key: null,
    })
    await rpc.registerPayments({ p_entry_id: e, p_discount_cents: null, p_payments: [{ amount_cents: 18000, method: 'credit_balance' }], p_request_id: crypto.randomUUID(), p_paid_at: null })
  })

  // ---- debt: two old entries (40 + 60) plus the 300 left above; settle 70 with Pix + Permuta, oldest first
  const mk = (desc: string, cents: number, daysAgo: number) =>
    rpc.createManualEntry({
      p_kind: 'income', p_description: desc, p_category: null, p_amount_cents: cents, p_due_date: addDaysYMD(today, -daysAgo),
      p_client_id: clientId, p_professional_id: null, p_pay_now: false, p_method: null, p_import_key: null,
    })
  const e1 = await mk('ZZ Conta divida A', 4000, 60)
  await mk('ZZ Conta divida B', 6000, 50)
  acct = await rpc.getClientAccount({ p_client_id: clientId })
  check('account: open debt = 40 + 60 + 300', acct.open_debt_cents === 40000 && acct.open_entries[0]?.entry_id === e1, JSON.stringify(acct.open_entries))
  const settleReq = crypto.randomUUID()
  const lines = [
    { amount_cents: 3000, method: 'pix' as const },
    { amount_cents: 4000, method: 'barter' as const },
  ]
  const res = await rpc.settleClientAccount({ p_client_id: clientId, p_payments: lines, p_request_id: settleReq, p_note: 'ZZ ref', p_paid_at: null })
  check('account: settlement allocates 3 rows oldest first', res.length === 3 && res[0]?.entry_id === e1, JSON.stringify(res))
  const res2 = await rpc.settleClientAccount({ p_client_id: clientId, p_payments: lines, p_request_id: settleReq, p_note: 'ZZ ref', p_paid_at: null })
  check('account: same request id returns the same result', JSON.stringify(res2) === JSON.stringify(res))
  acct = await rpc.getClientAccount({ p_client_id: clientId })
  check('account: debt 330 after settling 70', acct.open_debt_cents === 33000, String(acct.open_debt_cents))
  await expectCode('account: adjustment in a settlement -> METHOD_NOT_ALLOWED', 'METHOD_NOT_ALLOWED', () =>
    rpc.settleClientAccount({ p_client_id: clientId, p_payments: [{ amount_cents: 100, method: 'adjustment' }], p_request_id: crypto.randomUUID(), p_note: null, p_paid_at: null }),
  )
  await expectCode('account: settlement above the debt -> OVERPAYMENT', 'OVERPAYMENT', () =>
    rpc.settleClientAccount({ p_client_id: clientId, p_payments: [{ amount_cents: 33001, method: 'pix' }], p_request_id: crypto.randomUUID(), p_note: null, p_paid_at: null }),
  )
  const sum = await rpc.clientAccountSummary({ p_client_ids: [clientId] })
  check('account: summary matches', sum[0]?.credit_balance_cents === 17000 && sum[0].open_debt_cents === 33000, JSON.stringify(sum))

  // settle everything: credit 170 + Pix 160
  await rpc.settleClientAccount({
    p_client_id: clientId,
    p_payments: [{ amount_cents: 17000, method: 'credit_balance' }, { amount_cents: 16000, method: 'pix' }],
    p_request_id: crypto.randomUUID(), p_note: null, p_paid_at: null,
  })
  acct = await rpc.getClientAccount({ p_client_id: clientId })
  check('account: all settled, no credit left', acct.open_debt_cents === 0 && acct.credit_balance_cents === 0, JSON.stringify(acct))
  const fin = await rpc.financeSummary({ p_from: today, p_to: today, p_professional_id: null })
  check('account: summary has accounts and a non-cash list', typeof fin.accounts.credit_total_cents === 'number' && fin.noncash_by_method.some((m) => m.method === 'credit_balance'))

  // ---- Mara: FORBIDDEN on every new RPC
  await login('mara@studio.test')
  await expectCode('mara: add_client_credit -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.addClientCredit({ p_client_id: clientId, p_amount_cents: 100, p_method: 'pix', p_note: null, p_request_id: crypto.randomUUID(), p_opening: false, p_paid_at: null }),
  )
  await expectCode('mara: settle_client_account -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.settleClientAccount({ p_client_id: clientId, p_payments: [{ amount_cents: 100, method: 'pix' }], p_request_id: crypto.randomUUID(), p_note: null, p_paid_at: null }),
  )
  await expectCode('mara: get_client_account -> FORBIDDEN', 'FORBIDDEN', () => rpc.getClientAccount({ p_client_id: clientId }))
  await expectCode('mara: client_account_summary -> FORBIDDEN', 'FORBIDDEN', () => rpc.clientAccountSummary({ p_client_ids: [clientId] }))
  const { data: va } = await supabase.from('v_client_account').select('client_id')
  check('mara: no SELECT on v_client_account', (va ?? []).length === 0)
  await login('karol@studio.test')
}

/** Finance: complete_and_pay with discount + split, statement, reverse, expense, receivables import (twice), Mara FORBIDDEN. */
async function financeFlow(maraId: string) {
  const today = todaySP()
  const horizon = addDaysYMD(today, 90)

  // ---- fixtures: a service Mara performs, a client
  const { data: svcRows } = await supabase.from('services').select('id').eq('name', 'ZZ Financeiro Fluxo')
  const svcId = await rpc.upsertService({
    p_id: svcRows?.[0]?.id ?? null,
    p_name: 'ZZ Financeiro Fluxo',
    p_category: 'unhas',
    p_kind: 'standard',
    p_duration_min: 30,
    p_price_cents: 5000,
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
  const clientId = await rpc.upsertClient({ p_name: 'ZZ Cliente Financeiro', p_phone: '11 95555-0009', p_external_code: null, p_birthday: null, p_notes: null })

  // ---- book (last free slot so other flows never collide), complete_and_pay with discount and split
  const avail = await rpc.getAvailability({
    p_professional_id: maraId,
    p_service_id: svcId,
    p_action: 'placement',
    p_addon_ids: [],
    p_from: addDaysYMD(today, 3),
    p_to: addDaysYMD(today, 30),
    p_source: 'staff',
  })
  const slot = avail.at(-1)
  if (!slot) throw new Error('no free slot for the finance flow')
  const apptId = await rpc.bookAppointment({
    p_client_id: clientId,
    p_professional_id: maraId,
    p_service_id: svcId,
    p_action: 'placement',
    p_addon_ids: [],
    p_starts_at: slot.starts_at,
    p_source: 'staff',
    p_idempotency_key: crypto.randomUUID(),
    p_notes: null,
    p_client_package_id: null,
  })
  const before = await rpc.financeEntry({ p_appointment_id: apptId, p_client_package_id: null })
  check('finance: entry before completion is open', before?.amount_cents === 5000 && before.open_cents === 5000 && before.status !== 'paid')

  const requestId = crypto.randomUUID()
  const lines = [
    { amount_cents: 1500, method: 'pix' },
    { amount_cents: 2500, method: 'cash' },
  ]
  const paid = await rpc.completeAndPay({
    p_appointment_id: apptId,
    p_actual_end: null,
    p_discount_cents: 1000,
    p_payments: lines,
    p_request_id: requestId,
  })
  check('finance: complete_and_pay -> paid, final 40', paid.status === 'paid' && paid.final_cents === 4000 && paid.open_cents === 0, JSON.stringify(paid))
  check('finance: appointment completed', (await statusOf(apptId)) === 'completed')
  const again = await rpc.completeAndPay({
    p_appointment_id: apptId,
    p_actual_end: null,
    p_discount_cents: 1000,
    p_payments: lines,
    p_request_id: requestId,
  })
  check('finance: same request_id replays without duplicating', again.payment_ids.length === 2 && again.paid_cents === 4000, JSON.stringify(again))
  const { data: comm } = await supabase
    .from('ledger_entries')
    .select('commission_base_cents,commission_cents,studio_cents')
    .eq('id', paid.entry_id)
    .maybeSingle()
  check('finance: Mara 50% of the discounted value', comm?.commission_base_cents === 4000 && comm.commission_cents === 2000 && comm.studio_cents === 2000, JSON.stringify(comm))

  const statement = () =>
    rpc.financeList({
      p_mode: 'statement',
      p_from: today,
      p_to: today,
      p_status: null,
      p_professional_id: null,
      p_client_id: clientId,
      p_query: null,
      p_include_reversed: false,
      p_limit: 50,
      p_offset: 0,
    })
  const stmt = await statement()
  check('finance: both payments in the Extrato', stmt.filter((r) => r.entry_id === paid.entry_id).length === 2, String(stmt.length))
  const summary = await rpc.financeSummary({ p_from: today, p_to: today, p_professional_id: null })
  check('finance: summary received >= 40', summary.cards.received_cents >= 4000)

  // ---- reverse -> back to A receber
  for (const r of stmt.filter((x) => x.entry_id === paid.entry_id)) await rpc.reversePayment({ p_payment_id: r.payment_id })
  const receivable = () =>
    rpc.financeList({
      p_mode: 'receivable',
      p_from: today,
      p_to: horizon,
      p_status: null,
      p_professional_id: maraId,
      p_client_id: clientId,
      p_query: null,
      p_include_reversed: false,
      p_limit: 50,
      p_offset: 0,
    })
  const back = (await receivable()).find((r) => r.entry_id === paid.entry_id)
  check('finance: reversed -> open again in A receber', back?.open_cents === 4000, JSON.stringify(back?.open_cents))
  check('finance: reversed payments leave the Extrato', (await statement()).filter((r) => r.entry_id === paid.entry_id).length === 0)
  await expectCode('finance: overpayment -> OVERPAYMENT', 'OVERPAYMENT', () =>
    rpc.registerPayments({
      p_entry_id: paid.entry_id,
      p_discount_cents: null,
      p_payments: [{ amount_cents: 4001, method: 'pix' }],
      p_request_id: crypto.randomUUID(),
      p_paid_at: null,
    }),
  )
  await rpc.registerPayments({
    p_entry_id: paid.entry_id,
    p_discount_cents: null,
    p_payments: [{ amount_cents: 4000, method: 'pix' }],
    p_request_id: crypto.randomUUID(),
    p_paid_at: null,
  })
  check('finance: paid again', (await rpc.financeEntry({ p_appointment_id: apptId, p_client_package_id: null }))?.status === 'paid')

  // ---- expense: create, pay
  const expenseId = await rpc.createManualEntry({
    p_kind: 'expense',
    p_description: 'ZZ Despesa Fluxo',
    p_category: 'Materiais',
    p_amount_cents: 12345,
    p_due_date: today,
    p_client_id: null,
    p_professional_id: null,
    p_pay_now: false,
    p_method: null,
    p_import_key: null,
  })
  const payable = () =>
    rpc.financeList({
      p_mode: 'payable',
      p_from: today,
      p_to: today,
      p_status: null,
      p_professional_id: null,
      p_client_id: null,
      p_query: 'ZZ Despesa Fluxo',
      p_include_reversed: false,
      p_limit: 50,
      p_offset: 0,
    })
  check('finance: expense is in A pagar, open', (await payable()).find((r) => r.entry_id === expenseId)?.status !== 'paid')
  await rpc.registerPayments({
    p_entry_id: expenseId,
    p_discount_cents: null,
    p_payments: [{ amount_cents: 12345, method: 'pix' }],
    p_request_id: crypto.randomUUID(),
    p_paid_at: null,
  })
  check('finance: expense paid', (await payable()).find((r) => r.entry_id === expenseId)?.status === 'paid')

  // ---- receivables import, twice (a fresh year per run keeps re-runs independent)
  const year = 2100 - Math.floor(Math.random() * 50)
  const csv = readFileSync('tests/fixtures/receivables-sample.csv', 'utf-8').replaceAll('2031', String(year))
  const importOnce = async () => {
    const clients = await fetchExistingClients()
    const plan = await planReceivables(parseCsv(csv), clients)
    const existing = new Set(await rpc.financeImportKeys({ p_keys: plan.rows.map((r) => r.key) }))
    return { plan, result: await runReceivableImport(plan, (a) => rpc.createManualEntry(a), existing) }
  }
  const imp1 = await importOnce()
  check(
    'receivables import: 6 created, 4 skipped, no errors',
    imp1.result.created === 6 && imp1.result.skipped.length === 4 && imp1.result.errors.length === 0,
    JSON.stringify({ c: imp1.result.created, s: imp1.result.skipped.map((s) => s.reason), e: imp1.result.errors }),
  )
  const imp2 = await importOnce()
  check(
    'receivables import twice: second creates 0',
    imp2.result.created === 0 && imp2.result.alreadyThere === 6 && imp2.result.errors.length === 0,
    JSON.stringify(imp2.result),
  )
  const { data: keyed } = await supabase.from('ledger_entries').select('id').in('import_key', imp1.plan.rows.map((r) => r.key))
  check('receivables import: exactly 6 entries in the ledger', keyed?.length === 6, String(keyed?.length))

  // ---- Mara: everything financial is FORBIDDEN
  await login('mara@studio.test')
  const nil = '00000000-0000-0000-0000-000000000000'
  await expectCode('mara: finance_summary -> FORBIDDEN', 'FORBIDDEN', () => rpc.financeSummary({ p_from: today, p_to: today, p_professional_id: null }))
  await expectCode('mara: finance_list -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.financeList({
      p_mode: 'receivable',
      p_from: today,
      p_to: today,
      p_status: null,
      p_professional_id: null,
      p_client_id: null,
      p_query: null,
      p_include_reversed: false,
      p_limit: 5,
      p_offset: 0,
    }),
  )
  await expectCode('mara: finance_entry -> FORBIDDEN', 'FORBIDDEN', () => rpc.financeEntry({ p_appointment_id: apptId, p_client_package_id: null }))
  await expectCode('mara: register_payments -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.registerPayments({
      p_entry_id: paid.entry_id,
      p_discount_cents: null,
      p_payments: [{ amount_cents: 1, method: 'pix' }],
      p_request_id: crypto.randomUUID(),
      p_paid_at: null,
    }),
  )
  await expectCode('mara: complete_and_pay -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.completeAndPay({ p_appointment_id: apptId, p_actual_end: null, p_discount_cents: null, p_payments: [], p_request_id: crypto.randomUUID() }),
  )
  await expectCode('mara: reverse_payment -> FORBIDDEN', 'FORBIDDEN', () => rpc.reversePayment({ p_payment_id: nil }))
  await expectCode('mara: create_manual_entry -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.createManualEntry({
      p_kind: 'expense',
      p_description: 'x',
      p_category: null,
      p_amount_cents: 100,
      p_due_date: today,
      p_client_id: null,
      p_professional_id: null,
      p_pay_now: false,
      p_method: null,
      p_import_key: null,
    }),
  )
  await expectCode('mara: edit_entry -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.editEntry({ p_entry_id: expenseId, p_description: 'x', p_category: null, p_due_date: today, p_amount_cents: null }),
  )
  await expectCode('mara: void_entry -> FORBIDDEN', 'FORBIDDEN', () => rpc.voidEntry({ p_entry_id: expenseId }))
  await expectCode('mara: set_commission_rule -> FORBIDDEN', 'FORBIDDEN', () =>
    rpc.setCommissionRule({ p_professional_id: maraId, p_category: null, p_percent: 99 }),
  )
  const ledger = await supabase.from('ledger_entries').select('id').limit(1)
  const vled = await supabase.from('v_ledger').select('id').limit(1)
  const pays = await supabase.from('ledger_payments').select('id').limit(1)
  check('mara: no rows from ledger_entries, v_ledger, ledger_payments', (ledger.data ?? []).length === 0 && (vled.data ?? []).length === 0 && (pays.data ?? []).length === 0)

  // ---- cleanup (owner): void the imported rows so the local ledger stays tidy
  await login('karol@studio.test')
  for (const e of keyed ?? []) await rpc.voidEntry({ p_entry_id: e.id })
  const income = await rpc.financeList({
    p_mode: 'statement',
    p_from: today,
    p_to: today,
    p_status: null,
    p_professional_id: null,
    p_client_id: null,
    p_query: 'ZZ Despesa Fluxo',
    p_include_reversed: false,
    p_limit: 5,
    p_offset: 0,
  })
  check('finance: expenses never appear in the income Extrato', income.length === 0)
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
  await login('karol@studio.test')
  await financeFlow(mara.id)
  await login('karol@studio.test')
  await accountFlow(mara.id)

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
