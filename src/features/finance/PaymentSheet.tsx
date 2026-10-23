import { useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, Kicker, MoneyInput, Sheet, useSnackbar } from '../../components/ui'
import { useEligiblePackages, usePackagePreview } from '../../lib/clientQueries'
import { formatDate, toSaoPauloISO } from '../../lib/datetime'
import { creditExceeded, creditLineLimit, CREDIT_METHOD, linesPayload, PAY_METHODS, paymentMath, type PayLine, type PayMethod } from '../../lib/finance'
import { useClientAccountSummary } from '../../lib/financeQueries'
import { formatBRL } from '../../lib/money'
import { invalidateAll } from '../../lib/queries'
import { HAS_PAYMENTS_PACKAGE_HINT, packageChipLabel, packageUsedMessage, packageUseText, previewSession } from '../../lib/packageUse'
import { messageOf, RpcError, rpc } from '../../lib/rpc'

export interface PayTarget {
  /** 'complete' completes the appointment and receives in one transaction; 'pay' receives on an existing entry. */
  mode: 'pay' | 'complete'
  /** Pay mode: the ledger entry. */
  entryId?: string
  /** The appointment: Complete mode needs it; in pay mode it only enables the package chip. */
  appointmentId?: string
  /** The appointment's start (ISO), to preview the package session number. */
  startsAt?: string
  /** Complete mode: the appointment's São Paulo day, for Término real. */
  day?: string
  title: string
  detail: string
  grossCents: number
  discountCents?: number
  paidCents?: number
  /** Income: the client, so the sheet can offer the client credit. */
  clientId?: string | null
  /** Expenses: no discount field, no barter. */
  kind?: 'income' | 'expense'
}

/** One payment component used everywhere: Agenda, Financeiro, package sale. Children mount only while open, so state resets. */
export function PaymentSheet({ target, onClose, onDone }: { target: PayTarget | null; onClose: () => void; onDone?: () => void }) {
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      kicker="Financeiro"
      title={target?.kind === 'expense' ? 'Pagar' : target?.mode === 'complete' ? 'Concluir atendimento' : 'Receber'}
    >
      {target && <PaymentPanel target={target} onDone={() => (onDone ?? onClose)()} onCancel={onClose} />}
    </Sheet>
  )
}

export function PaymentPanel({
  target,
  onDone,
  onCancel,
}: {
  target: PayTarget
  onDone: (result?: { actualEnd: string | null }) => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  // One request id per open: retrying the same sheet can never register twice.
  const requestId = useRef(crypto.randomUUID())
  const expense = target.kind === 'expense'
  const complete = target.mode === 'complete'
  const gross = target.grossCents
  const paid = target.paidCents ?? 0
  const clientId = !expense ? (target.clientId ?? null) : null
  const account = useClientAccountSummary(clientId ? [clientId] : [], !!clientId)
  const balance = clientId ? (account.data?.get(clientId)?.balance ?? 0) : 0

  const [discount, setDiscount] = useState<number | null>(target.discountCents ? target.discountCents : null)
  const [lines, setLines] = useState<PayLine[]>([{ method: 'pix', cents: null }])
  const [end, setEnd] = useState('') // Término real: empty by default, empty sends null
  const [pending, setPending] = useState(false)

  const base = paymentMath(gross, discount, [], paid)
  // A single untouched line stands for "the whole amount".
  const effective: PayLine[] =
    lines.length === 1 && lines[0]!.cents === null ? [{ ...lines[0]!, cents: base.total > 0 ? base.total : null }] : lines
  const m = paymentMath(gross, discount, effective, paid)
  const canReceive = m.canReceive && !creditExceeded(effective, balance)
  const baseMethods: Array<{ value: PayMethod; label: string }> = expense ? PAY_METHODS.filter((x) => x.value !== 'barter') : PAY_METHODS
  const methods = balance > 0 ? [...baseMethods, { value: CREDIT_METHOD.value, label: `${CREDIT_METHOD.label} (${formatBRL(balance)})` }] : baseMethods
  const packageSession = complete && gross === 0

  // Package at payment (owner only; income of an appointment that still costs something).
  const eligible = useEligiblePackages(target.appointmentId, !expense && !packageSession && gross > 0)
  const packages = eligible.data ?? []
  const [usePkg, setUsePkg] = useState(false)
  const [pkgChoice, setPkgChoice] = useState<string | null>(null)
  const chosen = packages.find((p) => p.client_package_id === pkgChoice) ?? packages[0] ?? null // the list comes ordered by expiry
  const preview = usePackagePreview(usePkg ? chosen?.client_package_id : null)
  const slot = chosen && preview.data ? previewSession(preview.data.total, chosen.remaining, preview.data.starts, target.startsAt) : null
  const pkgMode = usePkg && !!chosen

  function setLine(i: number, patch: Partial<PayLine>) {
    setLines((cur) => {
      const start = cur.length === 1 && cur[0]!.cents === null ? effective : cur
      const next = start.map((l, j) => (j === i ? { ...l, ...patch } : l))
      const line = next[i]!
      if (line.method !== 'credit_balance') return next
      // Credit line: limited to min(balance, remaining).
      const limit = creditLineLimit(next, i, balance, base.total)
      const cents = patch.method === 'credit_balance' ? (limit > 0 ? limit : null) : line.cents === null ? null : Math.min(line.cents, limit)
      return next.map((l, j) => (j === i ? { ...l, cents } : l))
    })
  }

  function split() {
    setLines((cur) => [...(cur.length === 1 && cur[0]!.cents === null ? effective : cur), { method: 'cash', cents: null }])
  }

  async function submit(receive: boolean) {
    let iso: string | null = null
    if (complete && end !== '') {
      iso = target.day ? toSaoPauloISO(target.day, end) : null
      if (!iso) {
        snack.show('Horário de término inválido.', 'error')
        return
      }
    }
    setPending(true)
    try {
      if (pkgMode) {
        // Package session: price 0, no discount, no payments. Complete mode applies the package and completes in ONE transaction.
        const used = complete
          ? await rpc.completeAndPay({
              p_appointment_id: target.appointmentId!,
              p_actual_end: iso,
              p_discount_cents: null,
              p_payments: [],
              p_request_id: requestId.current,
              p_client_package_id: chosen!.client_package_id,
            })
          : await rpc.applyPackageToAppointment({ p_appointment_id: target.appointmentId!, p_client_package_id: chosen!.client_package_id })
        snack.show(used.session_number && used.sessions_total ? packageUsedMessage({ session_number: used.session_number, sessions_total: used.sessions_total }) : 'Sessão do pacote usada')
        invalidateAll(qc)
        onDone({ actualEnd: iso })
        return
      }
      if (complete) {
        await rpc.completeAndPay({
          p_appointment_id: target.appointmentId!,
          p_actual_end: iso,
          p_discount_cents: receive && discount ? discount : null,
          p_payments: receive ? linesPayload(effective) : [],
          p_request_id: requestId.current,
        })
        snack.show(receive ? 'Atendimento concluído e recebido' : 'Atendimento concluído')
      } else {
        await rpc.registerPayments({
          p_entry_id: target.entryId!,
          p_discount_cents: discount,
          p_payments: linesPayload(effective),
          p_request_id: requestId.current,
          p_paid_at: null,
        })
        snack.show(expense ? 'Pagamento registrado' : 'Recebimento registrado')
      }
      invalidateAll(qc)
      onDone({ actualEnd: iso })
    } catch (e) {
      const hint = pkgMode && e instanceof RpcError && e.code === 'HAS_PAYMENTS' ? `. ${HAS_PAYMENTS_PACKAGE_HINT}` : ''
      snack.show(`${messageOf(e)}${hint}`, 'error')
    } finally {
      setPending(false)
    }
  }

  const pkgChip = chosen ? (
    <Chip key="pkg" selected={pkgMode} onClick={() => setUsePkg(true)}>
      {packageChipLabel(chosen.remaining)}
    </Chip>
  ) : null

  return (
    <div className="space-y-5">
      <div>
        <p className="title-serif text-xl">{target.title}</p>
        <p className="text-help">{target.detail}</p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Kicker>Valor</Kicker>
          <p className="title-serif text-xl">{formatBRL(gross)}</p>
        </div>
        {paid > 0 && (
          <div>
            <Kicker>Já recebido</Kicker>
            <p className="title-serif text-xl">{formatBRL(paid)}</p>
          </div>
        )}
      </div>

      {!expense && gross > 0 && !pkgMode && (
        <div>
          <FieldLabel htmlFor="pay-discount">Desconto (R$)</FieldLabel>
          <MoneyInput id="pay-discount" value={discount} onChange={setDiscount} />
          {!m.discountOk && (
            <p role="alert" className="text-help mt-2 !text-danger">
              Desconto maior que o valor ou menor que o já recebido.
            </p>
          )}
        </div>
      )}

      {pkgMode && chosen && (
        <div className="space-y-3">
          <ChipRow>
            {pkgChip}
            {methods.map((x) => (
              <Chip
                key={x.value}
                onClick={() => {
                  setUsePkg(false)
                  setLine(0, { method: x.value as PayMethod })
                }}
              >
                {x.label}
              </Chip>
            ))}
          </ChipRow>
          {packages.length > 1 && (
            <div>
              <FieldLabel htmlFor="pay-package">Pacote</FieldLabel>
              <select
                id="pay-package"
                value={chosen.client_package_id}
                onChange={(e) => setPkgChoice(e.target.value)}
                className="hit w-full rounded-[var(--radius-input)] border border-line bg-surface px-3"
              >
                {packages.map((p) => (
                  <option key={p.client_package_id} value={p.client_package_id}>
                    {`${p.template_name} · ${p.remaining} restantes · vence ${formatDate(p.expires_at)}`}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="rounded-[var(--radius-input)] border border-border-gold bg-surface-2 px-4 py-3">
            <p className="title-serif text-lg" aria-live="polite">
              {packageUseText(slot)}
            </p>
          </div>
        </div>
      )}

      {!packageSession && !pkgMode && (
        <>
          <div className="rounded-[var(--radius-input)] border border-border-gold bg-surface-2 px-4 py-3">
            <Kicker>{expense ? 'Total a pagar' : 'Total a receber'}</Kicker>
            <p className="title-serif text-3xl">{formatBRL(m.total)}</p>
          </div>

          <div className="space-y-4">
            {effective.map((l, i) => (
              <div key={i} className="space-y-2">
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor={`pay-line-${i}`}>{effective.length > 1 ? `Pagamento ${i + 1}` : 'Forma de pagamento'}</FieldLabel>
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
                  {i === 0 && pkgChip}
                  {methods.map((x) => (
                    <Chip key={x.value} selected={l.method === x.value} onClick={() => setLine(i, { method: x.value as PayMethod })}>
                      {x.label}
                    </Chip>
                  ))}
                </ChipRow>
                <MoneyInput id={`pay-line-${i}`} value={l.cents} onChange={(c) => setLine(i, { cents: c })} />
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <Button variant="secondary" icon={<Plus size={16} />} onClick={split}>
              Dividir
            </Button>
            <p className={`text-help text-right ${m.remaining < 0 ? '!text-danger' : ''}`} aria-live="polite">
              {m.remaining < 0 ? `Excede em ${formatBRL(-m.remaining)}` : `Falta ${formatBRL(m.remaining)}`}
            </p>
          </div>
        </>
      )}

      {complete && (
        <div>
          <FieldLabel htmlFor="real-end">Término real</FieldLabel>
          <Input id="real-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          <p className="text-help mt-2">Deixe em branco para manter o término previsto.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {pkgMode ? (
          <Button loading={pending} onClick={() => void submit(true)}>
            {complete ? 'Concluir e usar pacote' : 'Usar pacote'}
          </Button>
        ) : packageSession ? (
          <Button loading={pending} onClick={() => void submit(false)}>
            Concluir
          </Button>
        ) : (
          <>
            <Button loading={pending} disabled={!canReceive} onClick={() => void submit(true)}>
              {complete ? 'Concluir e receber' : expense ? 'Pagar' : 'Receber'}
            </Button>
            {complete ? (
              <Button variant="secondary" disabled={pending} onClick={() => void submit(false)}>
                Concluir, receber depois
              </Button>
            ) : (
              <Button variant="secondary" disabled={pending} onClick={() => onDone()}>
                {expense ? 'Pagar depois' : 'Receber depois'}
              </Button>
            )}
          </>
        )}
        {onCancel && (
          <Button variant="ghost" disabled={pending} onClick={onCancel}>
            Voltar
          </Button>
        )}
      </div>
    </div>
  )
}
