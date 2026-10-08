import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { Button, Chip, ChipRow, EmptyState, FieldLabel, Input, Pill, Sheet, Skeleton, Textarea, useSnackbar } from '../../components/ui'
import { endedEarly } from '../../lib/adjust'
import { formatDayLong, formatTime, todaySP, toSaoPauloISO, ymdOf } from '../../lib/datetime'
import { formatPhoneBR, toTitlePt } from '../../lib/format'
import { invalidateAll, useAvailability, useSuggestedProfessionals, type AppointmentRow } from '../../lib/queries'
import { messageOf, RpcError, rpc } from '../../lib/rpc'
import { reversePaymentsOfEntry, useFinanceEntry } from '../../lib/financeQueries'
import { PaymentPanel } from '../finance/PaymentSheet'
import { AdjustTimePanel, AnteciparPanel } from './AdjustTime'
import { EditAppointmentPanel } from './EditAppointment'
import { PackagePill, serviceLine, StatusPill } from './common'

export type SheetMode = 'view' | 'reschedule' | 'adjust' | 'edit' | 'antecipar' | 'cancel' | 'complete' | 'pay'

const CANCEL_REASONS = ['Cliente cancelou', 'Reagendou', 'Outro']

export function AppointmentSheet({
  appointment,
  initialMode = 'view',
  onClose,
}: {
  appointment: AppointmentRow | null
  initialMode?: SheetMode
  onClose: () => void
}) {
  return (
    <Sheet
      open={!!appointment}
      onClose={onClose}
      kicker="Agendamento"
      title={appointment ? toTitlePt(appointment.client?.name) : ''}
    >
      {appointment && <Body key={appointment.id} a={appointment} initialMode={initialMode} onClose={onClose} />}
    </Sheet>
  )
}

function Body({ a, initialMode, onClose }: { a: AppointmentRow; initialMode: SheetMode; onClose: () => void }) {
  const [mode, setMode] = useState<SheetMode>(initialMode)
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [pending, setPending] = useState(false)
  const { isOwner } = useAuth()
  // Owner only: the entry behind this appointment (amount, discount, paid). Professionals never query it.
  const entry = useFinanceEntry({ appointmentId: a.id }, isOwner)
  const [hasPayments, setHasPayments] = useState(false)
  const [early, setEarly] = useState<string | null>(null) // real end of an appointment closed before its planned end

  async function reversePayments() {
    if (!entry.data) return
    setPending(true)
    try {
      const n = await reversePaymentsOfEntry(entry.data.entry_id, a.client_id)
      invalidateAll(qc)
      setHasPayments(false)
      snack.show(n === 1 ? 'Pagamento estornado' : 'Pagamentos estornados')
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  /** After closing: offer "Antecipar" when the real end is before the planned end, else just close. */
  function afterClose(realEnd: string | null) {
    if (realEnd && endedEarly(realEnd, a.ends_at)) {
      setEarly(realEnd)
      setMode('antecipar')
    } else onClose()
  }

  async function run(fn: () => Promise<unknown>, okMsg: string, next: () => void = onClose) {
    setPending(true)
    try {
      await fn()
      invalidateAll(qc)
      snack.show(okMsg)
      next()
    } catch (e) {
      if (isOwner && e instanceof RpcError && e.code === 'HAS_PAYMENTS') {
        setHasPayments(true)
        setMode('view')
      }
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  const active = a.status === 'scheduled' || a.status === 'confirmed'
  const day = ymdOf(a.starts_at)

  if (mode === 'reschedule') return <Reschedule a={a} onBack={() => setMode('view')} onClose={onClose} />

  if (mode === 'adjust') return <AdjustTimePanel a={a} onBack={() => setMode('view')} onClose={onClose} />

  if (mode === 'edit') return <EditAppointmentPanel a={a} onBack={() => setMode('view')} onClose={onClose} />

  if (mode === 'antecipar' && early)
    return <AnteciparPanel professionalId={a.professional_id} from={early} onDone={onClose} onSkip={onClose} />

  if (mode === 'cancel') return <Cancel a={a} onBack={() => setMode('view')} run={run} pending={pending} />

  if (mode === 'complete') {
    if (!isOwner) return <Complete a={a} day={day} onBack={() => setMode('view')} run={run} afterClose={afterClose} pending={pending} />
    if (!entry.data) return <Skeleton className="h-40" />
    return (
      <PaymentPanel
        target={{
          mode: 'complete',
          appointmentId: a.id,
          day,
          clientId: a.client_id,
          title: toTitlePt(a.client?.name),
          detail: serviceLine(a, true),
          grossCents: entry.data.amount_cents,
          discountCents: entry.data.discount_cents,
          paidCents: entry.data.paid_cents,
        }}
        onDone={(r) => afterClose(r?.actualEnd ?? null)}
        onCancel={() => setMode('view')}
      />
    )
  }

  if (mode === 'pay' && entry.data) {
    return (
      <PaymentPanel
        target={{
          mode: 'pay',
          entryId: entry.data.entry_id,
          clientId: a.client_id,
          title: toTitlePt(a.client?.name),
          detail: serviceLine(a, true),
          grossCents: entry.data.amount_cents,
          discountCents: entry.data.discount_cents,
          paidCents: entry.data.paid_cents,
        }}
        onDone={onClose}
        onCancel={() => setMode('view')}
      />
    )
  }

  const money = isOwner && a.status === 'completed' && entry.data && entry.data.final_cents > 0 ? entry.data : null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <StatusPill status={a.status} />
        <Pill color={a.professional?.color}>{toTitlePt(a.professional?.name)}</Pill>
        <PackagePill a={a} />
        {money &&
          (money.status === 'paid' ? (
            <Pill tone="success">PAGO</Pill>
          ) : (
            <button type="button" onClick={() => setMode('pay')} aria-label="Receber" className="rounded-full">
              <Pill tone={money.paid_cents > 0 ? 'warn' : 'gold'}>{money.paid_cents > 0 ? 'PARCIAL' : 'A RECEBER'}</Pill>
            </button>
          ))}
      </div>
      {hasPayments && (
        <div role="alert" className="space-y-3 rounded-[var(--radius-input)] border border-line px-4 py-3">
          <p className="text-help !text-danger">Este agendamento tem pagamentos registrados. Estorne-os antes de continuar.</p>
          <Button variant="secondary" loading={pending} onClick={() => void reversePayments()}>
            Estornar pagamentos
          </Button>
        </div>
      )}
      <dl className="space-y-4">
        <Info label="Telefone" value={formatPhoneBR(a.client?.phone_e164)} />
        <Info label="Serviço" value={serviceLine(a, true)} />
        <Info label="Horário" value={`${formatDayLong(a.starts_at)} · ${formatTime(a.starts_at)} – ${formatTime(a.ends_at)}`} />
        {a.notes && <Info label="Observações" value={a.notes} />}
      </dl>

      {active ? (
        <div className="flex flex-wrap gap-2 pt-2">
          {a.status === 'scheduled' && (
            <Button loading={pending} onClick={() => void run(() => rpc.confirmAppointment({ p_appointment_id: a.id }), 'Agendamento confirmado')}>
              Confirmar
            </Button>
          )}
          <Button variant="secondary" onClick={() => setMode('reschedule')}>
            Reagendar
          </Button>
          <Button variant="secondary" onClick={() => setMode('adjust')}>
            Ajustar horário
          </Button>
          <Button variant="secondary" onClick={() => setMode('edit')}>
            Alterar serviço
          </Button>
          <Button variant="secondary" onClick={() => setMode('complete')}>
            Concluir
          </Button>
          <Button
            variant="secondary"
            loading={pending}
            onClick={() => void run(() => rpc.markNoShow({ p_appointment_id: a.id }), 'Falta registrada')}
          >
            Faltou
          </Button>
          <Button variant="danger" onClick={() => setMode('cancel')}>
            Cancelar
          </Button>
        </div>
      ) : (
        <div className="space-y-3 pt-2">
          <p className="text-help">Este agendamento está encerrado e não pode ser alterado.</p>
          {a.status === 'completed' && (
            <Button variant="secondary" onClick={() => setMode('edit')}>
              Alterar serviço
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label-caps mb-1">{label}</dt>
      <dd className="text-base">{value}</dd>
    </div>
  )
}

function Reschedule({ a, onBack, onClose }: { a: AppointmentRow; onBack: () => void; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const today = todaySP()
  const [date, setDate] = useState(() => {
    const d = ymdOf(a.starts_at, today)
    return d < today ? today : d
  })
  const [proId, setProId] = useState(a.professional_id)
  const [pending, setPending] = useState(false)

  const pros = useSuggestedProfessionals(a.client_id, a.service_id)
  const slots = useAvailability({
    professionalId: proId,
    serviceId: a.service_id,
    action: a.action,
    addonIds: a.addons.map((x) => x.addon_id),
    from: date,
    to: date,
  })

  async function pick(startsAt: string) {
    setPending(true)
    try {
      await rpc.rescheduleAppointment({
        p_appointment_id: a.id,
        p_new_starts_at: startsAt,
        p_new_professional_id: proId,
        p_force: false,
      })
      invalidateAll(qc)
      snack.show('Agendamento reagendado')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
      void slots.refetch()
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-help">Escolha o novo dia, a profissional e o horário.</p>
      <div>
        <FieldLabel htmlFor="rs-date">Dia</FieldLabel>
        <Input id="rs-date" type="date" min={today} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      </div>
      <div>
        <FieldLabel>Profissional</FieldLabel>
        <ChipRow>
          {(pros.data ?? []).map((p) => (
            <Chip key={p.professional_id} dot={p.color} selected={p.professional_id === proId} onClick={() => setProId(p.professional_id)}>
              {toTitlePt(p.name)}
            </Chip>
          ))}
        </ChipRow>
      </div>
      <div>
        <FieldLabel>Horários</FieldLabel>
        {slots.isLoading ? (
          <Skeleton className="h-11" />
        ) : (slots.data ?? []).length === 0 ? (
          <EmptyState title="Sem horários neste dia" help="Tente outro dia ou outra profissional." />
        ) : (
          <ChipRow>
            {(slots.data ?? []).map((s) => (
              <Chip key={s.starts_at} disabled={pending} onClick={() => void pick(s.starts_at)}>
                {formatTime(s.starts_at)}
              </Chip>
            ))}
          </ChipRow>
        )}
      </div>
      <Button variant="ghost" onClick={onBack}>
        Voltar
      </Button>
    </div>
  )
}

function Cancel({
  a,
  onBack,
  run,
  pending,
}: {
  a: AppointmentRow
  onBack: () => void
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>
  pending: boolean
}) {
  const [reason, setReason] = useState<string | null>(null)
  const [text, setText] = useState('')
  const full = [reason, text.trim()].filter(Boolean).join(': ')
  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>Motivo</FieldLabel>
        <ChipRow>
          {CANCEL_REASONS.map((r) => (
            <Chip key={r} selected={reason === r} onClick={() => setReason(r)}>
              {r}
            </Chip>
          ))}
        </ChipRow>
      </div>
      <div>
        <FieldLabel htmlFor="cancel-text">Detalhes</FieldLabel>
        <Textarea id="cancel-text" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button
          variant="danger"
          loading={pending}
          disabled={!reason}
          onClick={() => void run(() => rpc.cancelAppointment({ p_appointment_id: a.id, p_reason: full }), 'Agendamento cancelado')}
        >
          Cancelar agendamento
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
      </div>
    </div>
  )
}

function Complete({
  a,
  day,
  onBack,
  run,
  afterClose,
  pending,
}: {
  a: AppointmentRow
  day: string
  onBack: () => void
  run: (fn: () => Promise<unknown>, ok: string, next?: () => void) => Promise<void>
  afterClose: (realEnd: string | null) => void
  pending: boolean
}) {
  // Empty by default: never prefilled with the current time. Empty sends null (keeps the planned end).
  const [end, setEnd] = useState('')
  const snack = useSnackbar()

  function submit() {
    let iso: string | null = null
    if (end !== '') {
      iso = toSaoPauloISO(day, end)
      if (!iso) {
        snack.show('Horário de término inválido.', 'error')
        return
      }
    }
    void run(() => rpc.completeAppointment({ p_appointment_id: a.id, p_actual_end: iso }), 'Agendamento concluído', () => afterClose(iso))
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel htmlFor="real-end">Término real</FieldLabel>
        <Input id="real-end" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        <p className="text-help mt-2">Deixe em branco para manter o término previsto.</p>
      </div>
      <div className="flex gap-2">
        <Button loading={pending} onClick={submit}>
          Concluir
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
      </div>
    </div>
  )
}
