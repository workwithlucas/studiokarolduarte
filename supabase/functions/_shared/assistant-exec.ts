// Execution and undo of confirmed assistant proposals. Every step is one rpc_* call (its own transaction) on the
// owner-scoped client, so the RPC owner checks apply. Idempotency keys derive from the pending id and the action index.
import type { PendingActionItem, ResultLine, UndoItem } from './assistant-types.ts'
import { METHOD_LABEL, derivedUuid, fmtMoney, importKey } from './assistant-validate.ts'
import { RpcFailure, callRpc } from './db.ts'
import { messageOfCode } from './errors-pt.ts'
import type { Db } from './types.ts'

export type ActionOutcome =
  | { ok: true; text: string; undo: UndoItem | null }
  | { ok: false; code: string; message: string }

const uuidOf = (x: unknown): string | null => (typeof x === 'string' ? x : null)

async function call<T = any>(db: Db, fn: string, args: Record<string, unknown>): Promise<T> {
  return await callRpc<T>(db, fn, args)
}

async function paymentIds(db: Db, entryId: string): Promise<string[]> {
  const e = await call<{ payments?: Array<{ payment_id: string }> } | null>(db, 'rpc_finance_entry_by_id', { p_entry_id: entryId, p_payment_id: null })
  return (e?.payments ?? []).map((p) => p.payment_id)
}

const paysText = (pays: Array<{ amount_cents: number; method: string }>) => pays.map((p) => `${fmtMoney(p.amount_cents)} no ${METHOD_LABEL[p.method] ?? p.method}`).join(' + ')

/** Runs one action. Rule violations come back as {ok:false} with the pt-BR text from errors-pt.ts. */
export async function executeAction(db: Db, pendingId: string, index: number, item: PendingActionItem): Promise<ActionOutcome> {
  try {
    return await run(db, pendingId, index, item)
  } catch (e) {
    if (e instanceof RpcFailure) return { ok: false, code: e.code, message: messageOfCode(e.code, e.detail) }
    return { ok: false, code: 'INTERNAL', message: 'Erro inesperado ao executar. Confira o lançamento antes de tentar de novo.' }
  }
}

async function run(db: Db, pendingId: string, index: number, item: PendingActionItem): Promise<ActionOutcome> {
  const p = item.params as Record<string, any>
  const requestId = await derivedUuid(pendingId, index)
  switch (item.kind) {
    case 'create_entry': {
      const id = uuidOf(await call(db, 'rpc_create_manual_entry', {
        p_kind: p.entry_kind, p_description: p.description, p_category: p.category ?? null, p_amount_cents: p.amount_cents, p_due_date: p.due_date,
        p_client_id: p.client_id ?? null, p_professional_id: null, p_pay_now: !!p.pay_now, p_method: p.pay_now ? p.method : null, p_import_key: importKey(pendingId, index),
      }))
      if (!id) return { ok: false, code: 'INTERNAL', message: 'Não recebi o identificador do lançamento.' }
      const steps = [] as UndoItem['steps']
      if (p.pay_now) for (const pid of await paymentIds(db, id)) steps.push({ rpc: 'rpc_reverse_payment', args: { p_payment_id: pid } })
      steps.push({ rpc: 'rpc_void_entry', args: { p_entry_id: id } })
      const exp = p.entry_kind === 'expense'
      return {
        ok: true,
        text: `${exp ? 'despesa' : 'receita'} lançada: ${p.description}, ${fmtMoney(p.amount_cents)}${p.pay_now ? ` (${exp ? 'paga' : 'recebida'} no ${METHOD_LABEL[p.method] ?? p.method})` : ' (em aberto)'}`,
        undo: { index, label: 'lançamento cancelado', steps, done: false },
      }
    }
    case 'register_payments':
    case 'complete_and_pay': {
      if (item.kind === 'complete_and_pay' && p.client_package_id) {
        const r = await call(db, 'rpc_complete_and_pay', {
          p_appointment_id: p.appointment_id, p_actual_end: null, p_discount_cents: null, p_payments: [], p_request_id: requestId, p_client_package_id: p.client_package_id,
        })
        return {
          ok: true,
          text: `atendimento concluído com a sessão ${r?.session_number ?? '?'}/${r?.sessions_total ?? '?'} do pacote (restam ${r?.remaining ?? '?'})`,
          undo: { index, label: 'sessão do pacote devolvida', steps: [{ rpc: 'rpc_remove_package_from_appointment', args: { p_appointment_id: p.appointment_id } }], done: false },
        }
      }
      const r = item.kind === 'complete_and_pay'
        ? await call(db, 'rpc_complete_and_pay', { p_appointment_id: p.appointment_id, p_actual_end: null, p_discount_cents: p.discount_cents ?? null, p_payments: p.payments, p_request_id: requestId, p_client_package_id: null })
        : await call(db, 'rpc_register_payments', { p_entry_id: p.entry_id, p_discount_cents: p.discount_cents ?? null, p_payments: p.payments, p_request_id: requestId })
      const ids: string[] = Array.isArray(r?.payment_ids) ? r.payment_ids : []
      const left = typeof r?.open_cents === 'number' && r.open_cents > 0 ? `restam ${fmtMoney(r.open_cents)}` : 'quitado'
      return {
        ok: true,
        text: `${item.kind === 'complete_and_pay' ? 'atendimento concluído e ' : ''}pagamento registrado: ${paysText(p.payments)} (${left})`,
        undo: ids.length ? { index, label: 'pagamento estornado', steps: ids.map((pid) => ({ rpc: 'rpc_reverse_payment', args: { p_payment_id: pid } })), done: false } : null,
      }
    }
    case 'apply_package': {
      const r = await call(db, 'rpc_apply_package_to_appointment', { p_appointment_id: p.appointment_id, p_client_package_id: p.client_package_id })
      return {
        ok: true,
        text: `sessão ${r?.session_number ?? '?'}/${r?.sessions_total ?? '?'} do pacote usada no atendimento (restam ${r?.remaining ?? '?'})`,
        undo: { index, label: 'sessão do pacote devolvida', steps: [{ rpc: 'rpc_remove_package_from_appointment', args: { p_appointment_id: p.appointment_id } }], done: false },
      }
    }
    case 'reverse_payment': {
      await call(db, 'rpc_reverse_payment', { p_payment_id: p.payment_id })
      const redo = p.method !== 'adjustment'
      return {
        ok: true,
        text: `pagamento estornado: ${fmtMoney(p.amount_cents)} no ${METHOD_LABEL[p.method] ?? p.method}`,
        undo: redo
          ? {
              index, label: 'estorno desfeito', done: false,
              steps: [{ rpc: 'rpc_register_payments', args: { p_entry_id: p.entry_id, p_discount_cents: null, p_payments: [{ amount_cents: p.amount_cents, method: p.method }], p_request_id: await derivedUuid(pendingId, index, 'undo'), p_paid_at: p.paid_at ?? null } }],
            }
          : null,
      }
    }
    case 'void_entry': {
      await call(db, 'rpc_void_entry', { p_entry_id: p.entry_id })
      return { ok: true, text: 'lançamento cancelado', undo: null }
    }
    case 'edit_entry': {
      await call(db, 'rpc_edit_entry', { p_entry_id: p.entry_id, p_description: p.description ?? null, p_category: null, p_due_date: p.due_date ?? null, p_amount_cents: p.amount_cents ?? null })
      const b = p.before ?? {}
      return {
        ok: true,
        text: 'lançamento editado',
        undo: { index, label: 'edição revertida', done: false, steps: [{ rpc: 'rpc_edit_entry', args: { p_entry_id: p.entry_id, p_description: b.description ?? null, p_category: null, p_due_date: b.due_date ?? null, p_amount_cents: b.amount_cents ?? null } }] },
      }
    }
    case 'add_credit': {
      const id = uuidOf(await call(db, 'rpc_add_client_credit', { p_client_id: p.client_id, p_amount_cents: p.amount_cents, p_method: p.method, p_note: null, p_request_id: requestId, p_opening: false }))
      const steps = id ? (await paymentIds(db, id)).map((pid) => ({ rpc: 'rpc_reverse_payment', args: { p_payment_id: pid } })) : []
      return {
        ok: true,
        text: `crédito adicionado: ${fmtMoney(p.amount_cents)} no ${METHOD_LABEL[p.method] ?? p.method}`,
        undo: steps.length ? { index, label: 'crédito estornado', steps, done: false } : null,
      }
    }
    case 'settle_account': {
      const acct = await call<{ open_entries?: Array<{ entry_id: string }> }>(db, 'rpc_get_client_account', { p_client_id: p.client_id })
      const watch = (acct?.open_entries ?? []).map((e) => e.entry_id)
      const before = new Set<string>()
      for (const eid of watch) for (const pid of await paymentIds(db, eid)) before.add(pid)
      const alloc = (await call<Array<{ entry_id: string; amount_cents: number }>>(db, 'rpc_settle_client_account', { p_client_id: p.client_id, p_payments: p.payments, p_request_id: requestId })) ?? []
      const created: string[] = []
      for (const eid of new Set(alloc.map((a) => a.entry_id))) for (const pid of await paymentIds(db, eid)) if (!before.has(pid)) created.push(pid)
      return {
        ok: true,
        text: `conta da cliente quitada: ${paysText(p.payments)}`,
        undo: created.length ? { index, label: 'pagamentos da conta estornados', steps: created.map((pid) => ({ rpc: 'rpc_reverse_payment', args: { p_payment_id: pid } })), done: false } : null,
      }
    }
    default:
      return { ok: false, code: 'INTERNAL', message: 'Ação desconhecida.' }
  }
}

export interface ExecutionSummary {
  status: 'confirmed' | 'failed'
  lines: ResultLine[]
  undo: UndoItem[]
  reply: string
}

/** Runs every action in order; one failure does not stop the others. The reply is built here, never by the model. */
export async function executeAll(db: Db, pendingId: string, actions: PendingActionItem[]): Promise<ExecutionSummary> {
  const lines: ResultLine[] = []
  const undo: UndoItem[] = []
  const done: string[] = []
  const failed: string[] = []
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i]!
    const out = await executeAction(db, pendingId, i, a)
    if (out.ok) {
      lines.push({ index: i, ok: true, text: out.text })
      done.push(out.text)
      if (out.undo) undo.push(out.undo)
    } else {
      const t = `${a.summary.title}: ${out.message}`
      lines.push({ index: i, ok: false, text: t })
      failed.push(t)
    }
  }
  const reply = [
    done.length ? `Feito: ${done.join('; ')}.` : '',
    failed.length ? `${done.length ? 'Não consegui' : 'Não consegui concluir'}: ${failed.join('; ')}` : '',
  ].filter(Boolean).join(' ')
  return { status: done.length === 0 ? 'failed' : 'confirmed', lines, undo, reply }
}

/** Runs the stored inverse of one action through the same RPCs. A blocked undo returns the RPC message. */
export async function runUndo(db: Db, item: UndoItem): Promise<{ ok: true } | { ok: false; message: string }> {
  for (const s of item.steps) {
    try {
      await callRpc(db, s.rpc, s.args)
    } catch (e) {
      if (e instanceof RpcFailure) return { ok: false, message: messageOfCode(e.code, e.detail) }
      return { ok: false, message: 'Erro inesperado ao desfazer.' }
    }
  }
  return { ok: true }
}
