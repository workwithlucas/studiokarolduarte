import { useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, Kicker, MoneyInput, Pill, SectionHeader, Sheet, Skeleton, Toggle, useSnackbar } from '../../components/ui'
import { formatDate } from '../../lib/datetime'
import {
  allocationPreview,
  creditExceeded,
  creditLineLimit,
  CREDIT_METHOD,
  DEPOSIT_METHODS,
  linesPayload,
  methodLabel,
  PAY_METHODS,
  type ClientAccount,
  type PayLine,
  type PayMethod,
} from '../../lib/finance'
import { useClientAccount } from '../../lib/financeQueries'
import { toTitlePt } from '../../lib/format'
import { formatBRL } from '../../lib/money'
import { invalidateAll } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'
import { ClientPicker, type PickedClient } from '../clients/ClientPicker'

const MOVE_LABEL: Record<ClientAccount['movements'][number]['type'], string> = {
  deposit: 'Crédito',
  use: 'Uso de crédito',
  settlement: 'Recebimento da conta',
  opening: 'Saldo anterior',
}

/** Client page › CONTA DA CLIENTE (owner only): credit, open debt, open entries, last movements. */
export function ClientAccountSection({ clientId }: { clientId: string }) {
  const account = useClientAccount(clientId)
  const [addOpen, setAddOpen] = useState(false)
  const [settleOpen, setSettleOpen] = useState(false)
  const a = account.data

  return (
    <section>
      <SectionHeader>Conta da cliente</SectionHeader>
      {account.isLoading || !a ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card">
              <Kicker>Crédito</Kicker>
              <p className="title-serif text-2xl">{formatBRL(a.credit_balance_cents)}</p>
            </div>
            <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card">
              <Kicker>Em aberto</Kicker>
              <p className={`title-serif text-2xl ${a.open_debt_cents > 0 ? '!text-danger' : ''}`}>{formatBRL(a.open_debt_cents)}</p>
              <p className="text-help">
                {a.open_entries_count} {a.open_entries_count === 1 ? 'lançamento' : 'lançamentos'}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Plus size={16} />} onClick={() => setAddOpen(true)}>
              Adicionar crédito
            </Button>
            <Button disabled={a.open_debt_cents <= 0} onClick={() => setSettleOpen(true)}>
              Receber da conta
            </Button>
          </div>

          {a.open_entries.length > 0 && (
            <div>
              <Kicker className="mb-2">Lançamentos em aberto</Kicker>
              <ul className="space-y-2">
                {a.open_entries.map((e) => (
                  <li key={e.entry_id} className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                    <div className="min-w-0">
                      <p className="title-serif truncate text-lg">{e.description}</p>
                      <p className="text-help">vence {formatDate(e.due_date)}</p>
                    </div>
                    <p className="title-serif shrink-0 text-lg">{formatBRL(e.open_cents)}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {a.movements.length > 0 && (
            <div>
              <Kicker className="mb-2">Últimas movimentações</Kicker>
              <ul className="space-y-2">
                {a.movements.map((m, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                    <div className="min-w-0">
                      <p className="title-serif truncate text-lg">{MOVE_LABEL[m.type]}</p>
                      <p className="text-help truncate">
                        {formatDate(m.date)}
                        {m.note ? ` · ${m.note}` : ''}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Pill tone={m.method === 'barter' ? 'primary' : 'neutral'}>{methodLabel(m.method)}</Pill>
                      <p className="title-serif text-lg">{formatBRL(m.amount_cents)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <AddCreditSheet open={addOpen} clientId={clientId} onClose={() => setAddOpen(false)} />
      <SettleSheet open={settleOpen} clientId={clientId} account={a} onClose={() => setSettleOpen(false)} />
    </section>
  )
}

// ---------------------------------------------------------------- Adicionar crédito
export function AddCreditSheet({ open, clientId, clientName, onClose }: { open: boolean; clientId: string | null; clientName?: string; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Conta da cliente" title="Adicionar crédito">
      {open && clientId && <AddCreditPanel clientId={clientId} clientName={clientName} onDone={onClose} onCancel={onClose} />}
    </Sheet>
  )
}

function AddCreditPanel({ clientId, clientName, onDone, onCancel }: { clientId: string; clientName?: string; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const requestId = useRef(crypto.randomUUID())
  const [amount, setAmount] = useState<number | null>(null)
  const [method, setMethod] = useState<PayMethod>('pix')
  const [note, setNote] = useState('')
  const [opening, setOpening] = useState(false)
  const [pending, setPending] = useState(false)

  async function save() {
    if (amount === null || amount <= 0) return
    setPending(true)
    try {
      await rpc.addClientCredit({
        p_client_id: clientId,
        p_amount_cents: amount,
        p_method: method,
        p_note: note.trim() || null,
        p_request_id: requestId.current,
        p_opening: opening,
        p_paid_at: null,
      })
      invalidateAll(qc)
      snack.show(opening ? 'Saldo anterior lançado' : 'Crédito adicionado')
      onDone()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      {clientName && <p className="title-serif text-xl">{toTitlePt(clientName)}</p>}
      <div>
        <FieldLabel htmlFor="credit-amount">Valor</FieldLabel>
        <MoneyInput id="credit-amount" value={amount} onChange={setAmount} disabled={pending} />
      </div>
      {!opening && (
        <div>
          <FieldLabel>Forma de pagamento</FieldLabel>
          <ChipRow>
            {DEPOSIT_METHODS.map((m) => (
              <Chip key={m.value} selected={method === m.value} onClick={() => setMethod(m.value)}>
                {m.label}
              </Chip>
            ))}
          </ChipRow>
        </div>
      )}
      <div>
        <FieldLabel htmlFor="credit-note">Observação</FieldLabel>
        <Input id="credit-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-base">Saldo anterior, sem entrada no caixa</span>
        <Toggle checked={opening} onChange={setOpening} label="Saldo anterior, sem entrada no caixa" />
      </div>
      <div className="flex gap-2">
        <Button loading={pending} disabled={amount === null || amount <= 0} onClick={() => void save()}>
          Adicionar crédito
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Voltar
        </Button>
      </div>
    </div>
  )
}

/** Financeiro › + Lançamento › Crédito de cliente: pick the client, then the same sheet. */
export function ClientCreditFlowSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Financeiro" title="Crédito de cliente">
      {open && <ClientCreditFlow onClose={onClose} />}
    </Sheet>
  )
}

function ClientCreditFlow({ onClose }: { onClose: () => void }) {
  const [client, setClient] = useState<PickedClient | null>(null)
  if (!client) return <ClientPicker onPick={setClient} />
  return <AddCreditPanel clientId={client.id} clientName={client.name} onDone={onClose} onCancel={() => setClient(null)} />
}

// ---------------------------------------------------------------- Receber da conta
function SettleSheet({ open, clientId, account, onClose }: { open: boolean; clientId: string; account: ClientAccount | undefined; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Conta da cliente" title="Receber da conta">
      {open && account && <SettlePanel clientId={clientId} account={account} onDone={onClose} onCancel={onClose} />}
    </Sheet>
  )
}

function SettlePanel({ clientId, account, onDone, onCancel }: { clientId: string; account: ClientAccount; onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  // One request id per open: a retry can never settle twice.
  const requestId = useRef(crypto.randomUUID())
  const debt = account.open_debt_cents
  const balance = account.credit_balance_cents
  const [lines, setLines] = useState<PayLine[]>([{ method: 'pix', cents: null }])
  const [note, setNote] = useState('')
  const [pending, setPending] = useState(false)

  // A single untouched line stands for the whole debt.
  const effective: PayLine[] = lines.length === 1 && lines[0]!.cents === null ? [{ ...lines[0]!, cents: debt > 0 ? debt : null }] : lines
  const entered = effective.reduce((n, l) => n + (l.cents ?? 0), 0)
  const preview = allocationPreview(account.open_entries, entered, debt)
  const linesOk = effective.every((l) => l.cents === null || l.cents > 0)
  const canSettle = entered > 0 && entered <= debt && linesOk && !creditExceeded(effective, balance)
  const methods: Array<{ value: PayMethod; label: string }> =
    balance > 0 ? [...PAY_METHODS, { value: CREDIT_METHOD.value, label: `${CREDIT_METHOD.label} (${formatBRL(balance)})` }] : PAY_METHODS

  function setLine(i: number, patch: Partial<PayLine>) {
    setLines((cur) => {
      const start = cur.length === 1 && cur[0]!.cents === null ? effective : cur
      const next = start.map((l, j) => (j === i ? { ...l, ...patch } : l))
      const line = next[i]!
      if (line.method !== 'credit_balance') return next
      // Credit line: limited to min(balance, remaining debt).
      const limit = creditLineLimit(next, i, balance, debt)
      const cents = patch.method === 'credit_balance' ? (limit > 0 ? limit : null) : line.cents === null ? null : Math.min(line.cents, limit)
      return next.map((l, j) => (j === i ? { ...l, cents } : l))
    })
  }

  async function submit() {
    setPending(true)
    try {
      await rpc.settleClientAccount({
        p_client_id: clientId,
        p_payments: linesPayload(effective),
        p_request_id: requestId.current,
        p_note: note.trim() || null,
        p_paid_at: null,
      })
      invalidateAll(qc)
      snack.show('Recebimento da conta registrado')
      onDone()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  const left = debt - entered

  return (
    <div className="space-y-5">
      <div className="rounded-[var(--radius-input)] border border-border-gold bg-surface-2 px-4 py-3">
        <Kicker>Em aberto</Kicker>
        <p className="title-serif text-3xl">{formatBRL(debt)}</p>
      </div>

      <div className="space-y-4">
        {effective.map((l, i) => (
          <div key={i} className="space-y-2">
            <div className="flex items-center justify-between">
              <FieldLabel htmlFor={`settle-line-${i}`}>{effective.length > 1 ? `Pagamento ${i + 1}` : 'Forma de pagamento'}</FieldLabel>
              {effective.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remover pagamento ${i + 1}`}
                  onClick={() => setLines((cur) => cur.filter((_, j) => j !== i))}
                  className="hit inline-flex items-center justify-center rounded-full"
                >
                  <X size={18} />
                </button>
              )}
            </div>
            <ChipRow>
              {methods.map((x) => (
                <Chip key={x.value} selected={l.method === x.value} onClick={() => setLine(i, { method: x.value })}>
                  {x.label}
                </Chip>
              ))}
            </ChipRow>
            <MoneyInput id={`settle-line-${i}`} value={l.cents} onChange={(c) => setLine(i, { cents: c })} disabled={pending} />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="secondary"
          icon={<Plus size={16} />}
          onClick={() => setLines([...(lines.length === 1 && lines[0]!.cents === null ? effective : lines), { method: 'cash', cents: null }])}
        >
          Dividir
        </Button>
        <p className={`text-help text-right ${left < 0 ? '!text-danger' : ''}`} aria-live="polite">
          {left < 0 ? `Excede em ${formatBRL(-left)}` : `Falta ${formatBRL(left)}`}
        </p>
      </div>

      <div>
        <FieldLabel htmlFor="settle-note">Referência</FieldLabel>
        <Input id="settle-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />
      </div>

      <div className="rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
        <Kicker className="mb-2">Como será aplicado (mais antigos primeiro)</Kicker>
        <ul className="space-y-1">
          {preview.rows
            .filter((r) => r.applied_cents > 0)
            .map((r) => (
              <li key={r.entry_id} className="flex justify-between gap-3">
                <span className="min-w-0 truncate">
                  {r.description} · {formatDate(r.due_date)}
                </span>
                <span className="title-serif shrink-0">
                  {formatBRL(r.applied_cents)}
                  {r.left_cents > 0 ? ` (resta ${formatBRL(r.left_cents)})` : ''}
                </span>
              </li>
            ))}
          {preview.applied === 0 && <li className="text-help">Informe um valor para ver a distribuição.</li>}
          <li className="flex justify-between border-t border-line pt-1">
            <span className="label-caps">Dívida restante</span>
            <span className="title-serif">{formatBRL(preview.remainingDebt)}</span>
          </li>
        </ul>
      </div>

      <div className="flex gap-2">
        <Button loading={pending} disabled={!canSettle} onClick={() => void submit()}>
          Receber
        </Button>
        <Button variant="ghost" disabled={pending} onClick={onCancel}>
          Voltar
        </Button>
      </div>
    </div>
  )
}
