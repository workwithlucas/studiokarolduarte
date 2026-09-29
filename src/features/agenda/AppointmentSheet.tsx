import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Chip, ChipRow, EmptyState, FieldLabel, Input, Pill, Sheet, Skeleton, Textarea, useSnackbar } from '../../components/ui'
import { formatDayLong, formatTime, todaySP, toSaoPauloISO, ymdOf } from '../../lib/datetime'
import { formatPhoneBR, toTitlePt } from '../../lib/format'
import { invalidateAll, useAvailability, useSuggestedProfessionals, type AppointmentRow } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'
import { serviceLine, StatusPill } from './common'

export type SheetMode = 'view' | 'reschedule' | 'cancel' | 'complete'

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

  async function run(fn: () => Promise<unknown>, okMsg: string) {
    setPending(true)
    try {
      await fn()
      invalidateAll(qc)
      snack.show(okMsg)
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  const active = a.status === 'scheduled' || a.status === 'confirmed'
  const day = ymdOf(a.starts_at)

  if (mode === 'reschedule') return <Reschedule a={a} onBack={() => setMode('view')} onClose={onClose} />

  if (mode === 'cancel') return <Cancel a={a} onBack={() => setMode('view')} run={run} pending={pending} />

  if (mode === 'complete') {
    return <Complete a={a} day={day} onBack={() => setMode('view')} run={run} pending={pending} />
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-2">
        <StatusPill status={a.status} />
        <Pill color={a.professional?.color}>{toTitlePt(a.professional?.name)}</Pill>
      </div>
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
        <p className="text-help">Este agendamento está encerrado e não pode ser alterado.</p>
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
  pending,
}: {
  a: AppointmentRow
  day: string
  onBack: () => void
  run: (fn: () => Promise<unknown>, ok: string) => Promise<void>
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
    void run(() => rpc.completeAppointment({ p_appointment_id: a.id, p_actual_end: iso }), 'Agendamento concluído')
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
