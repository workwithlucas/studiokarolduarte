import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, Kicker, MoneyInput, Sheet, Toggle, useSnackbar } from '../../components/ui'
import { formatDate, isValidYMD, todaySP } from '../../lib/datetime'
import { methodLabel, PAY_METHODS, type PayMethod } from '../../lib/finance'
import { toTitlePt } from '../../lib/format'
import { formatBRL } from '../../lib/money'
import type { FinanceRow } from '../../lib/financeQueries'
import { invalidateAll } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'
import { ClientPicker, type PickedClient } from '../clients/ClientPicker'

export const EXPENSE_CATEGORIES = ['Aluguel', 'Materiais', 'Produtos', 'Contas', 'Marketing', 'Impostos', 'Outros']

// ---------------------------------------------------------------- menus
export interface MenuAction {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
}

/** Touch-friendly "..." menu: a sheet with one button per action. */
export function ActionSheet({ open, title, actions, onClose }: { open: boolean; title: string; actions: MenuAction[]; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Ações" title={title}>
      <ul className="space-y-2">
        {actions.map((a) => (
          <li key={a.label}>
            <button
              type="button"
              disabled={a.disabled}
              onClick={() => {
                onClose()
                a.onClick()
              }}
              className={`hit flex w-full items-center rounded-[var(--radius-input)] border border-line px-4 text-left disabled:opacity-40 ${a.danger ? '!text-danger' : ''}`}
            >
              <span className="title-serif text-lg">{a.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}

export function ConfirmSheet({
  open,
  title,
  children,
  confirmLabel,
  pending,
  onConfirm,
  onClose,
}: {
  open: boolean
  title: string
  children: ReactNode
  confirmLabel: string
  pending?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Confirmar" title={title}>
      <div className="space-y-5">
        <div className="text-help">{children}</div>
        <div className="flex gap-2">
          <Button variant="danger" loading={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Voltar
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------- new expense / standalone income
export function NewEntrySheet({ kind, onClose }: { kind: 'expense' | 'income' | null; onClose: () => void }) {
  return (
    <Sheet open={kind !== null} onClose={onClose} kicker="Financeiro" title={kind === 'expense' ? 'Nova despesa' : 'Receita avulsa'}>
      {kind && <NewEntryForm kind={kind} onClose={onClose} />}
    </Sheet>
  )
}

function NewEntryForm({ kind, onClose }: { kind: 'expense' | 'income'; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const expense = kind === 'expense'
  const [description, setDescription] = useState('')
  const [category, setCategory] = useState('')
  const [amount, setAmount] = useState<number | null>(null)
  const [due, setDue] = useState(todaySP())
  const [client, setClient] = useState<PickedClient | null>(null)
  const [paidNow, setPaidNow] = useState(false)
  const [method, setMethod] = useState<PayMethod>('pix')
  const [pending, setPending] = useState(false)

  const methods = expense ? PAY_METHODS.filter((m) => m.value !== 'barter') : PAY_METHODS
  const valid = description.trim().length >= 2 && amount !== null && amount > 0 && isValidYMD(due)

  async function save() {
    if (amount === null) return
    setPending(true)
    try {
      await rpc.createManualEntry({
        p_kind: kind,
        p_description: description.trim(),
        p_category: category.trim() || null,
        p_amount_cents: amount,
        p_due_date: due,
        p_client_id: expense ? null : (client?.id ?? null),
        p_professional_id: null,
        p_pay_now: paidNow,
        p_method: paidNow ? method : null,
        p_import_key: null,
      })
      invalidateAll(qc)
      snack.show(expense ? 'Despesa lançada' : 'Receita lançada')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel htmlFor="ne-desc">Descrição</FieldLabel>
        <Input id="ne-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <FieldLabel>Categoria</FieldLabel>
        <ChipRow>
          {EXPENSE_CATEGORIES.map((c) => (
            <Chip key={c} selected={category === c} onClick={() => setCategory(category === c ? '' : c)}>
              {c}
            </Chip>
          ))}
        </ChipRow>
        <Input className="mt-2" aria-label="Outra categoria" placeholder="Ou digite outra" value={category} onChange={(e) => setCategory(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="ne-amount">Valor</FieldLabel>
          <MoneyInput id="ne-amount" value={amount} onChange={setAmount} />
        </div>
        <div>
          <FieldLabel htmlFor="ne-due">Vencimento</FieldLabel>
          <Input id="ne-due" type="date" value={due} onChange={(e) => e.target.value && setDue(e.target.value)} />
        </div>
      </div>
      {!expense && (
        <div>
          <FieldLabel>Cliente (opcional)</FieldLabel>
          {client ? (
            <div className="flex items-center justify-between gap-3">
              <p className="title-serif text-xl">{toTitlePt(client.name)}</p>
              <Button variant="ghost" onClick={() => setClient(null)}>
                Trocar
              </Button>
            </div>
          ) : (
            <ClientPicker onPick={setClient} />
          )}
        </div>
      )}
      <div className="flex items-center justify-between">
        <FieldLabel>Já paga</FieldLabel>
        <Toggle label="Já paga" checked={paidNow} onChange={setPaidNow} />
      </div>
      {paidNow && (
        <ChipRow>
          {methods.map((m) => (
            <Chip key={m.value} selected={method === m.value} onClick={() => setMethod(m.value)}>
              {m.label}
            </Chip>
          ))}
        </ChipRow>
      )}
      <Button block loading={pending} disabled={!valid} onClick={() => void save()}>
        Lançar
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- edit
export function EditEntrySheet({ row, onClose }: { row: FinanceRow | null; onClose: () => void }) {
  return (
    <Sheet open={!!row} onClose={onClose} kicker="Financeiro" title="Editar lançamento">
      {row && <EditForm key={row.entry_id} row={row} onClose={onClose} />}
    </Sheet>
  )
}

function EditForm({ row, onClose }: { row: FinanceRow; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [description, setDescription] = useState(row.description)
  const [category, setCategory] = useState(row.category ?? '')
  const [due, setDue] = useState(row.due_date)
  const [amount, setAmount] = useState<number | null>(row.amount_cents)
  const [pending, setPending] = useState(false)
  const linked = !!(row.appointment_id || row.client_package_id)
  const locked = linked && row.paid_cents > 0

  async function save() {
    setPending(true)
    try {
      await rpc.editEntry({
        p_entry_id: row.entry_id,
        p_description: description.trim(),
        p_category: category.trim(),
        p_due_date: due,
        p_amount_cents: amount,
      })
      invalidateAll(qc)
      snack.show('Lançamento atualizado')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel htmlFor="ee-desc">Descrição</FieldLabel>
        <Input id="ee-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="ee-cat">Categoria</FieldLabel>
        <Input id="ee-cat" list="ee-cats" value={category} onChange={(e) => setCategory(e.target.value)} />
        <datalist id="ee-cats">
          {EXPENSE_CATEGORIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="ee-amount">Valor</FieldLabel>
          <MoneyInput id="ee-amount" value={amount} onChange={setAmount} disabled={locked} />
        </div>
        <div>
          <FieldLabel htmlFor="ee-due">Vencimento</FieldLabel>
          <Input id="ee-due" type="date" value={due} onChange={(e) => e.target.value && setDue(e.target.value)} />
        </div>
      </div>
      {locked && <p className="text-help">O valor não pode mudar enquanto houver pagamentos. Estorne-os primeiro.</p>}
      <Button block loading={pending} disabled={description.trim().length < 2 || amount === null || !isValidYMD(due)} onClick={() => void save()}>
        Salvar
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- statement detail
export function PaymentDetailSheet({ row, onClose }: { row: FinanceRow | null; onClose: () => void }) {
  return (
    <Sheet open={!!row} onClose={onClose} kicker="Extrato" title="Pagamento">
      {row && <PaymentDetail row={row} onClose={onClose} />}
    </Sheet>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Kicker>{label}</Kicker>
      <p className="text-base">{value}</p>
    </div>
  )
}

function PaymentDetail({ row, onClose }: { row: FinanceRow; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [pending, setPending] = useState(false)

  async function reverse() {
    setPending(true)
    try {
      await rpc.reversePayment({ p_payment_id: row.payment_id })
      invalidateAll(qc)
      snack.show('Pagamento estornado')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  const hasCommission = row.commission_cents !== null
  return (
    <div className="space-y-5">
      <div>
        <p className="title-serif text-2xl">{formatBRL(row.payment_cents)}</p>
        <p className="text-help">
          {methodLabel(row.method)} · {formatDate(row.paid_at)}
          {row.reversed_at ? ' · estornado' : ''}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4">
        <Line label="Quem pagou" value={row.client_name ? toTitlePt(row.client_name) : row.description} />
        <Line label="Serviço" value={row.service_name ? toTitlePt(row.service_name) : row.description} />
        <Line label="Profissional" value={row.professional_name ? toTitlePt(row.professional_name) : '—'} />
        <Line label="Valor cheio" value={formatBRL(row.amount_cents)} />
        <Line label="Desconto" value={formatBRL(row.discount_cents)} />
        <Line label="Valor final" value={formatBRL(row.final_cents)} />
        <Line label="Comissão" value={hasCommission ? `${formatBRL(row.commission_cents)} (${row.commission_percent}%)` : '—'} />
        <Line label="Parte do studio" value={hasCommission ? formatBRL(row.studio_cents) : '—'} />
      </dl>
      {!row.reversed_at && (
        <Button variant="danger" loading={pending} onClick={() => void reverse()}>
          Estornar
        </Button>
      )}
    </div>
  )
}
