import { useQueryClient } from '@tanstack/react-query'
import { Plus, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, Kicker, MoneyInput, Sheet, useSnackbar } from '../../components/ui'
import { toSaoPauloISO } from '../../lib/datetime'
import { linesPayload, PAY_METHODS, paymentMath, type PayLine, type PayMethod } from '../../lib/finance'
import { formatBRL } from '../../lib/money'
import { invalidateAll } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

export interface PayTarget {
  /** 'complete' completes the appointment and receives in one transaction; 'pay' receives on an existing entry. */
  mode: 'pay' | 'complete'
  /** Pay mode: the ledger entry. */
  entryId?: string
  /** Complete mode: the appointment. */
  appointmentId?: string
  /** Complete mode: the appointment's São Paulo day, for Término real. */
  day?: string
  title: string
  detail: string
  grossCents: number
  discountCents?: number
  paidCents?: number
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

export function PaymentPanel({ target, onDone, onCancel }: { target: PayTarget; onDone: () => void; onCancel?: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  // One request id per open: retrying the same sheet can never register twice.
  const requestId = useRef(crypto.randomUUID())
  const expense = target.kind === 'expense'
  const complete = target.mode === 'complete'
  const gross = target.grossCents
  const paid = target.paidCents ?? 0

  const [discount, setDiscount] = useState<number | null>(target.discountCents ? target.discountCents : null)
  const [lines, setLines] = useState<PayLine[]>([{ method: 'pix', cents: null }])
  const [end, setEnd] = useState('') // Término real: empty by default, empty sends null
  const [pending, setPending] = useState(false)

  const base = paymentMath(gross, discount, [], paid)
  // A single untouched line stands for "the whole amount".
  const effective: PayLine[] =
    lines.length === 1 && lines[0]!.cents === null ? [{ ...lines[0]!, cents: base.total > 0 ? base.total : null }] : lines
  const m = paymentMath(gross, discount, effective, paid)
  const methods = expense ? PAY_METHODS.filter((x) => x.value !== 'barter') : PAY_METHODS
  const packageSession = complete && gross === 0

  function setLine(i: number, patch: Partial<PayLine>) {
    setLines((cur) => {
      const start = cur.length === 1 && cur[0]!.cents === null ? effective : cur
      return start.map((l, j) => (j === i ? { ...l, ...patch } : l))
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
      onDone()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

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

      {!expense && gross > 0 && (
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

      {!packageSession && (
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
        {packageSession ? (
          <Button loading={pending} onClick={() => void submit(false)}>
            Concluir
          </Button>
        ) : (
          <>
            <Button loading={pending} disabled={!m.canReceive} onClick={() => void submit(true)}>
              {complete ? 'Concluir e receber' : expense ? 'Pagar' : 'Receber'}
            </Button>
            {complete ? (
              <Button variant="secondary" disabled={pending} onClick={() => void submit(false)}>
                Concluir, receber depois
              </Button>
            ) : (
              <Button variant="secondary" disabled={pending} onClick={onDone}>
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
