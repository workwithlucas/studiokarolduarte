import { describe, expect, it } from 'vitest'
import { executeAction, executeAll, runUndo } from '../../supabase/functions/_shared/assistant-exec.ts'
import type { PendingActionItem } from '../../supabase/functions/_shared/assistant-types.ts'
import type { Db } from '../../supabase/functions/_shared/types.ts'

const P = '11111111-2222-4333-8444-555555555555'
const summary = { title: 'Ação', lines: [], warnings: [] }
const item = (kind: PendingActionItem['kind'], params: Record<string, unknown>): PendingActionItem => ({ kind, params, summary })

type Handler = (args: Record<string, any>) => unknown
interface Fake extends Db {
  calls: Array<{ fn: string; args: Record<string, any> }>
}
/** rpc stub: handlers return data, or { __error: 'CODE' } for a rule violation. */
function fakeDb(handlers: Record<string, Handler>): Fake {
  const calls: Fake['calls'] = []
  return {
    calls,
    rpc(fn, args = {}) {
      calls.push({ fn, args })
      const out = handlers[fn]?.(args) as any
      if (out && typeof out === 'object' && '__error' in out) return Promise.resolve({ data: null, error: { message: out.__error, details: null } })
      return Promise.resolve({ data: out ?? null, error: null })
    },
    from() {
      throw new Error('not used')
    },
  }
}

describe('undo derivation per action kind', () => {
  it('create entry, unpaid: void', async () => {
    const db = fakeDb({ rpc_create_manual_entry: () => 'e1' })
    const out = await executeAction(db, P, 0, item('create_entry', { entry_kind: 'expense', description: 'gás', category: 'Contas', amount_cents: 2000, due_date: '2026-10-23', pay_now: false }))
    expect(out.ok && out.undo?.steps).toEqual([{ rpc: 'rpc_void_entry', args: { p_entry_id: 'e1' } }])
  })
  it('create entry, paid: reverse the payment, then void', async () => {
    const db = fakeDb({ rpc_create_manual_entry: () => 'e1', rpc_finance_entry_by_id: () => ({ payments: [{ payment_id: 'p1' }] }) })
    const out = await executeAction(db, P, 3, item('create_entry', { entry_kind: 'expense', description: 'gás', category: 'Contas', amount_cents: 2000, due_date: '2026-10-23', pay_now: true, method: 'pix' }))
    expect(out.ok && out.undo?.steps.map((s) => s.rpc)).toEqual(['rpc_reverse_payment', 'rpc_void_entry'])
    expect(db.calls[0]!.args).toMatchObject({ p_import_key: `assist-${P}-3`, p_pay_now: true, p_method: 'pix', p_professional_id: null })
  })
  it('register payments: reverse the payments created', async () => {
    const db = fakeDb({ rpc_register_payments: () => ({ payment_ids: ['p1', 'p2'], open_cents: 0 }) })
    const out = await executeAction(db, P, 1, item('register_payments', { entry_id: 'e1', payments: [{ amount_cents: 5000, method: 'pix' }, { amount_cents: 3000, method: 'cash' }], discount_cents: null }))
    expect(out.ok && out.undo?.steps).toEqual([
      { rpc: 'rpc_reverse_payment', args: { p_payment_id: 'p1' } },
      { rpc: 'rpc_reverse_payment', args: { p_payment_id: 'p2' } },
    ])
    expect(db.calls[0]!.args.p_request_id).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('complete and pay: reverse the payments created', async () => {
    const db = fakeDb({ rpc_complete_and_pay: () => ({ payment_ids: ['p9'], open_cents: 100 }) })
    const out = await executeAction(db, P, 0, item('complete_and_pay', { entry_id: 'e1', appointment_id: 'a1', payments: [{ amount_cents: 7900, method: 'pix' }] }))
    expect(out.ok && out.undo?.steps).toEqual([{ rpc: 'rpc_reverse_payment', args: { p_payment_id: 'p9' } }])
    expect(out.ok && out.text).toContain('restam R$ 1,00')
  })
  it('complete and pay with a package: remove the package', async () => {
    const db = fakeDb({ rpc_complete_and_pay: () => ({ session_number: 1, sessions_total: 3, remaining: 2 }) })
    const out = await executeAction(db, P, 0, item('complete_and_pay', { entry_id: 'e1', appointment_id: 'a1', client_package_id: 'k1' }))
    expect(out.ok && out.undo?.steps).toEqual([{ rpc: 'rpc_remove_package_from_appointment', args: { p_appointment_id: 'a1' } }])
    expect(db.calls[0]!.args).toMatchObject({ p_client_package_id: 'k1', p_payments: [] })
    expect(out.ok && out.text).toContain('sessão 1/3')
  })
  it('apply package: remove the package', async () => {
    const db = fakeDb({ rpc_apply_package_to_appointment: () => ({ session_number: 2, sessions_total: 3, remaining: 1 }) })
    const out = await executeAction(db, P, 0, item('apply_package', { appointment_id: 'a1', client_package_id: 'k1' }))
    expect(out.ok && out.undo?.steps).toEqual([{ rpc: 'rpc_remove_package_from_appointment', args: { p_appointment_id: 'a1' } }])
  })
  it('reverse payment: register it again, with a derived request id and the original date', async () => {
    const db = fakeDb({})
    const out = await executeAction(db, P, 2, item('reverse_payment', { payment_id: 'p1', entry_id: 'e1', amount_cents: 8000, method: 'pix', paid_at: '2026-10-20T12:00:00+00:00' }))
    const step = out.ok ? out.undo?.steps[0] : null
    expect(step?.rpc).toBe('rpc_register_payments')
    expect(step?.args).toMatchObject({ p_entry_id: 'e1', p_payments: [{ amount_cents: 8000, method: 'pix' }], p_paid_at: '2026-10-20T12:00:00+00:00' })
    expect(step?.args.p_request_id).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('void entry: nothing to undo', async () => {
    const out = await executeAction(fakeDb({}), P, 0, item('void_entry', { entry_id: 'e1' }))
    expect(out.ok && out.undo).toBeNull()
  })
  it('edit entry: edit back to the values read at proposal time', async () => {
    const db = fakeDb({})
    const out = await executeAction(db, P, 0, item('edit_entry', { entry_id: 'e1', description: 'novo', due_date: null, amount_cents: 3500, before: { description: 'velho', due_date: '2026-10-23', amount_cents: 2500 } }))
    expect(out.ok && out.undo?.steps[0]).toEqual({ rpc: 'rpc_edit_entry', args: { p_entry_id: 'e1', p_description: 'velho', p_category: null, p_due_date: '2026-10-23', p_amount_cents: 2500 } })
  })
  it('add credit: reverse the deposit payment', async () => {
    const db = fakeDb({ rpc_add_client_credit: () => 'dep1', rpc_finance_entry_by_id: () => ({ payments: [{ payment_id: 'pd' }] }) })
    const out = await executeAction(db, P, 0, item('add_credit', { client_id: 'c1', amount_cents: 3000, method: 'pix' }))
    expect(out.ok && out.undo?.steps).toEqual([{ rpc: 'rpc_reverse_payment', args: { p_payment_id: 'pd' } }])
  })
  it('settle account: reverse only the payments the settlement created', async () => {
    let settled = false
    const db = fakeDb({
      rpc_get_client_account: () => ({ open_entries: [{ entry_id: 'e1' }] }),
      rpc_settle_client_account: () => ((settled = true), [{ entry_id: 'e1', amount_cents: 5000, method: 'pix' }]),
      rpc_finance_entry_by_id: () => ({ payments: settled ? [{ payment_id: 'old' }, { payment_id: 'new' }] : [{ payment_id: 'old' }] }),
    })
    const out = await executeAction(db, P, 0, item('settle_account', { client_id: 'c1', payments: [{ amount_cents: 5000, method: 'pix' }] }))
    expect(out.ok && out.undo?.steps).toEqual([{ rpc: 'rpc_reverse_payment', args: { p_payment_id: 'new' } }])
  })
})

describe('execution', () => {
  it('rule violations become the pt-BR message of the code (errors-pt)', async () => {
    const out = await executeAction(fakeDb({ rpc_void_entry: () => ({ __error: 'HAS_PAYMENTS' }) }), P, 0, item('void_entry', { entry_id: 'e1' }))
    expect(out).toEqual({ ok: false, code: 'HAS_PAYMENTS', message: 'Existem pagamentos registrados; estorne-os primeiro.' })
  })
  it('unexpected errors do not leak details', async () => {
    const db = { ...fakeDb({}), rpc: () => Promise.resolve({ data: null, error: { message: 'connection reset by peer', details: null } }) } as Db
    const out = await executeAction(db, P, 0, item('void_entry', { entry_id: 'e1' }))
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).not.toContain('connection')
  })
  it('one failure does not stop the others; the reply is code-built', async () => {
    let n = 0
    const db = fakeDb({ rpc_create_manual_entry: () => (++n === 2 ? { __error: 'BAD_AMOUNT' } : `e${n}`) })
    const mk = (d: string) => item('create_entry', { entry_kind: 'expense', description: d, category: 'Outros', amount_cents: 1000, due_date: '2026-10-23', pay_now: false })
    const r = await executeAll(db, P, [mk('um'), mk('dois'), mk('tres')])
    expect(r.lines.map((l) => l.ok)).toEqual([true, false, true])
    expect(r.status).toBe('confirmed')
    expect(r.undo.map((u) => u.index)).toEqual([0, 2])
    expect(r.reply.startsWith('Feito:')).toBe(true)
    expect(r.reply).toContain('Valor inválido.')
    expect(db.calls.map((c) => c.args.p_import_key)).toEqual([`assist-${P}-0`, `assist-${P}-1`, `assist-${P}-2`])
  })
  it('all failed: status failed', async () => {
    const r = await executeAll(fakeDb({ rpc_void_entry: () => ({ __error: 'NOT_FOUND' }) }), P, [item('void_entry', { entry_id: 'x' })])
    expect(r.status).toBe('failed')
    expect(r.reply.startsWith('Não consegui concluir')).toBe(true)
  })
  it('a blocked undo returns the RPC message and stops', async () => {
    const db = fakeDb({ rpc_void_entry: () => ({ __error: 'HAS_PAYMENTS' }) })
    const r = await runUndo(db, { index: 0, label: 'x', done: false, steps: [{ rpc: 'rpc_void_entry', args: {} }, { rpc: 'rpc_reverse_payment', args: {} }] })
    expect(r).toEqual({ ok: false, message: 'Existem pagamentos registrados; estorne-os primeiro.' })
    expect(db.calls.length).toBe(1)
  })
})
