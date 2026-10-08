import { useQueryClient } from '@tanstack/react-query'
import { Component, useRef, useState, type ReactNode } from 'react'
import { Button, EmptyState, FieldLabel, Input, Sheet, Skeleton, Toggle, useSnackbar } from '../../components/ui'
import { maskBRDate, maskTime24, newStartFromInputs } from '../../lib/adjust'
import { formatDate, formatDayLong, formatTime, parseDateTime } from '../../lib/datetime'
import { toTitlePt } from '../../lib/format'
import { NOTICE_MESSAGES, notifyReschedule } from '../../lib/notify'
import { invalidateAll, useFreeGap, type AppointmentRow } from '../../lib/queries'
import { RpcError, messageOf, rpc } from '../../lib/rpc'

/** Local error boundary: a render failure in the time-adjust UI never takes the sheet or the agenda down. */
export class LocalBoundary extends Component<{ children: ReactNode; onBack?: () => void }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="space-y-3">
        <p className="text-help !text-danger">Não foi possível mostrar esta tela. Tente de novo.</p>
        {this.props.onBack && (
          <Button variant="ghost" onClick={this.props.onBack}>
            Voltar
          </Button>
        )}
      </div>
    )
  }
}

/** The rpc.ts mapping, plus the database detail for conflicts (it names the client and the time). */
export function errorText(e: unknown): string {
  if (e instanceof RpcError && (e.code === 'SLOT_TAKEN' || e.code === 'BLOCKED') && e.detail) return e.detail
  return messageOf(e)
}

/** One adjustment: rpc, refresh, then the optional fixed WhatsApp notice. Throws only when the rpc fails. */
function useAdjust(onDone: () => void) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // one request id per attempted move: a retry after a lost response never moves twice
  const request = useRef<{ key: string; id: string } | null>(null)

  async function adjust(appointmentId: string, newStart: string, notify: boolean) {
    const key = `${appointmentId}|${newStart}`
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    const requestId = request.current.id
    setPending(true)
    setError(null)
    try {
      await rpc.adjustAppointmentTime({ p_appointment_id: appointmentId, p_new_start: newStart, p_request_id: requestId, p_notify: notify })
    } catch (e) {
      setError(errorText(e))
      setPending(false)
      return
    }
    invalidateAll(qc)
    snack.show('Horário ajustado')
    if (notify) {
      const note = NOTICE_MESSAGES[await notifyReschedule(requestId)]
      if (note) snack.show(note)
    }
    setPending(false)
    onDone()
  }

  return { adjust, pending, error }
}

function NotifyToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-base">Avisar cliente</span>
      <Toggle checked={value} onChange={onChange} label="Avisar cliente" />
    </div>
  )
}

export function AdjustTimePanel({ a, onBack, onClose }: { a: AppointmentRow; onBack: () => void; onClose: () => void }) {
  const [date, setDate] = useState(() => formatDate(a.starts_at, ''))
  const [time, setTime] = useState(() => formatTime(a.starts_at, ''))
  const [notify, setNotify] = useState(true)
  const { adjust, pending, error } = useAdjust(onClose)

  const newStart = newStartFromInputs(date, time)
  const current = parseDateTime(a.starts_at)
  const changed = !!newStart && !!current && parseDateTime(newStart)?.getTime() !== current.getTime()
  const dateBad = date.length === 10 && newStartFromInputs(date, '00:00') === null
  const timeBad = time.length === 5 && newStartFromInputs('01/01/2030', time) === null

  return (
    <LocalBoundary onBack={onBack}>
      <div className="space-y-5">
        <p className="text-help">
          A duração fica a mesma ({a.duration_min} min). Qualquer minuto vale; o término acompanha o novo início.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor="adj-date">Data</FieldLabel>
            <Input
              id="adj-date"
              inputMode="numeric"
              autoComplete="off"
              placeholder="DD/MM/AAAA"
              maxLength={10}
              value={date}
              aria-invalid={dateBad}
              onChange={(e) => setDate(maskBRDate(e.target.value))}
            />
          </div>
          <div>
            <FieldLabel htmlFor="adj-time">Horário</FieldLabel>
            <Input
              id="adj-time"
              inputMode="numeric"
              autoComplete="off"
              placeholder="HH:MM"
              maxLength={5}
              value={time}
              aria-invalid={timeBad}
              onChange={(e) => setTime(maskTime24(e.target.value))}
            />
          </div>
        </div>
        {(dateBad || timeBad) && (
          <p role="alert" className="text-help !text-danger">
            {dateBad ? 'Data inválida. Use DD/MM/AAAA.' : 'Horário inválido. Use HH:MM (24h).'}
          </p>
        )}
        <NotifyToggle value={notify} onChange={setNotify} />
        {error && (
          <p role="alert" className="text-help !text-danger">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button loading={pending} disabled={!changed} onClick={() => newStart && void adjust(a.id, newStart, notify)}>
            Salvar
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Voltar
          </Button>
        </div>
      </div>
    </LocalBoundary>
  )
}

/** Candidates that fit the free gap starting at `from`; "Antecipar para HH:MM" moves one to `from`. */
export function AnteciparPanel({
  professionalId,
  from,
  onDone,
  onSkip,
}: {
  professionalId: string
  from: string
  onDone: () => void
  onSkip: () => void
}) {
  const gap = useFreeGap(professionalId, from)
  const [notify, setNotify] = useState(true)
  const { adjust, pending, error } = useAdjust(onDone)

  return (
    <LocalBoundary onBack={onSkip}>
      <div className="space-y-5">
        {gap.isLoading ? (
          <Skeleton className="h-24" />
        ) : gap.isError ? (
          <p role="alert" className="text-help !text-danger">
            {errorText(gap.error)}
          </p>
        ) : !gap.data || gap.data.candidates.length === 0 ? (
          <EmptyState title="Ninguém para antecipar" help="Não há agendamentos do dia que caibam neste intervalo." />
        ) : (
          <>
            <p className="text-help">
              Intervalo livre de {formatTime(gap.data.start)} a {formatTime(gap.data.end)}. Quem pode vir mais cedo:
            </p>
            <ul className="space-y-3">
              {gap.data.candidates.map((c) => (
                <li key={c.appointmentId} className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-base">{toTitlePt(c.clientName)}</p>
                    <p className="text-help truncate">
                      {c.serviceName} · hoje {formatTime(c.startsAt)} · {c.durationMin} min
                    </p>
                  </div>
                  <Button loading={pending} onClick={() => void adjust(c.appointmentId, gap.data!.start, notify)}>
                    Antecipar para {formatTime(gap.data!.start)}
                  </Button>
                </li>
              ))}
            </ul>
            <NotifyToggle value={notify} onChange={setNotify} />
          </>
        )}
        {error && (
          <p role="alert" className="text-help !text-danger">
            {error}
          </p>
        )}
        <Button variant="ghost" onClick={onSkip}>
          Agora não
        </Button>
      </div>
    </LocalBoundary>
  )
}

/** Tap on an empty spot of the grid: new appointment, or bring someone forward into the gap. */
export function GapMenuSheet({
  target,
  onClose,
  onNew,
}: {
  target: { professionalId: string; from: string } | null
  onClose: () => void
  onNew: () => void
}) {
  return (
    <Sheet
      open={!!target}
      onClose={onClose}
      kicker="Horário livre"
      title={target ? `${formatDayLong(target.from)} · ${formatTime(target.from)}` : ''}
    >
      {target && (
        <div className="space-y-5">
          <Button onClick={onNew}>Novo agendamento</Button>
          <div>
            <p className="label-caps mb-3">Antecipar</p>
            <AnteciparPanel key={target.from + target.professionalId} professionalId={target.professionalId} from={target.from} onDone={onClose} onSkip={onClose} />
          </div>
        </div>
      )}
    </Sheet>
  )
}
