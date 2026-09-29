import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Lock, Plus, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { ImportAppointmentsSheet } from '../features/agenda/ImportAppointmentsSheet'
import { Button, Chip, ChipRow, EmptyState, Input, Kicker, Skeleton, TabLabel, TabList, useSnackbar } from '../components/ui'
import { AppointmentListRow } from '../features/agenda/AppointmentListRow'
import { AppointmentSheet, type SheetMode } from '../features/agenda/AppointmentSheet'
import { BlockDetailSheet, BlockSheet } from '../features/agenda/BlockSheet'
import { NewAppointmentSheet, type Prefill } from '../features/agenda/NewAppointmentSheet'
import { TimeGrid, type GridColumn } from '../features/agenda/TimeGrid'
import {
  addDaysYMD,
  formatDayLong,
  formatDayShort,
  hhmmToMinutes,
  isoAtMinutes,
  isValidYMD,
  minutesOfDaySP,
  todaySP,
  weekdayOf,
  weekStartYMD,
} from '../lib/datetime'
import { toTitlePt } from '../lib/format'
import { gridBounds } from '../lib/grid'
import {
  invalidateAll,
  useAgendaRealtime,
  useAppointments,
  useBlocks,
  useProfessionals,
  useToConfirm,
  useWorkingHours,
  type AppointmentRow,
  type Block,
} from '../lib/queries'
import { messageOf, rpc } from '../lib/rpc'

type View = 'dia' | 'semana'
interface Override {
  professional_id: string
  starts_at: string
  ends_at: string
}

export function AgendaPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'confirmar' ? 'confirmar' : 'agenda'
  const { isOwner } = useAuth()
  const [importOpen, setImportOpen] = useState(false)
  useAgendaRealtime()

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Kicker className="mb-1">Studio</Kicker>
          <h1 className="title-serif text-3xl">Agenda</h1>
        </div>
        {isOwner && (
          <Button variant="secondary" icon={<Upload size={16} />} onClick={() => setImportOpen(true)}>
            Importar
          </Button>
        )}
      </div>
      <TabList>
        <TabLabel active={tab === 'agenda'} onClick={() => setParams({})}>
          Agenda
        </TabLabel>
        <TabLabel active={tab === 'confirmar'} onClick={() => setParams({ tab: 'confirmar' })}>
          A confirmar
        </TabLabel>
      </TabList>
      <div className="mt-4">{tab === 'agenda' ? <AgendaTab /> : <ToConfirmTab />}</div>
      {isOwner && <ImportAppointmentsSheet open={importOpen} onClose={() => setImportOpen(false)} />}
    </div>
  )
}

function AgendaTab() {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [view, setView] = useState<View>('dia')
  const [date, setDate] = useState(todaySP())
  const [hidden, setHidden] = useState<string[]>([])
  const [weekPro, setWeekPro] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [selected, setSelected] = useState<AppointmentRow | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [prefill, setPrefill] = useState<Prefill | undefined>()
  const [blockOpen, setBlockOpen] = useState(false)
  const [blockSel, setBlockSel] = useState<Block | null>(null)

  const pros = useProfessionals()
  const hours = useWorkingHours()
  const active = useMemo(() => (pros.data ?? []).filter((p) => p.active), [pros.data])

  const from = view === 'dia' ? date : weekStartYMD(date, date)
  const to = view === 'dia' ? date : addDaysYMD(from, 6, from)
  const appts = useAppointments(from, to)
  const blocks = useBlocks(from, to)

  const proForWeek = active.find((p) => p.id === weekPro) ?? active[0]

  const columns = useMemo<GridColumn[]>(() => {
    const today = todaySP()
    const rangesFor = (proId: string, d: string) => {
      const wd = weekdayOf(d)
      return (hours.data ?? [])
        .filter((h) => h.professional_id === proId && h.weekday === wd)
        .map((h) => ({ start: hhmmToMinutes(h.start_time), end: hhmmToMinutes(h.end_time) }))
    }
    if (view === 'dia') {
      return active
        .filter((p) => !hidden.includes(p.id))
        .map((p) => ({
          key: `${p.id}|${date}`,
          date,
          professionalId: p.id,
          title: toTitlePt(p.name),
          color: p.color,
          today: date === today,
          ranges: rangesFor(p.id, date),
        }))
    }
    if (!proForWeek) return []
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDaysYMD(from, i, from)
      return {
        key: `${proForWeek.id}|${d}`,
        date: d,
        professionalId: proForWeek.id,
        title: formatDayShort(d).split(',')[0],
        subtitle: d.slice(8),
        color: proForWeek.color,
        today: d === today,
        ranges: rangesFor(proForWeek.id, d),
      }
    })
  }, [view, active, hidden, date, from, hours.data, proForWeek])

  const visibleAppts = useMemo(() => {
    const ids = new Set(columns.map((c) => c.professionalId))
    return (appts.data ?? [])
      .map((a) => {
        const o = overrides[a.id]
        if (!o) return a
        const pro = active.find((p) => p.id === o.professional_id)
        return { ...a, ...o, status: 'scheduled' as const, professional: pro ? { id: pro.id, name: pro.name, color: pro.color } : a.professional }
      })
      .filter((a) => ids.has(a.professional_id))
  }, [appts.data, columns, overrides, active])

  const bounds = useMemo(() => {
    const ranges = columns.flatMap((c) => c.ranges)
    // Appointments booked outside working hours ("Fora do horário") must stay visible.
    for (const a of visibleAppts) {
      const s = minutesOfDaySP(a.starts_at)
      ranges.push({ start: s, end: s + a.duration_min })
    }
    return gridBounds(ranges)
  }, [columns, visibleAppts])

  async function handleMove(a: AppointmentRow, col: GridColumn, startMin: number) {
    const startsAt = isoAtMinutes(col.date, startMin)
    if (!startsAt) return
    const endsAt = new Date(Date.parse(startsAt) + a.duration_min * 60_000).toISOString()
    setOverrides((o) => ({ ...o, [a.id]: { professional_id: col.professionalId, starts_at: startsAt, ends_at: endsAt } }))
    const revert = () =>
      setOverrides((o) => {
        const { [a.id]: _gone, ...rest } = o
        return rest
      })
    try {
      await rpc.rescheduleAppointment({
        p_appointment_id: a.id,
        p_new_starts_at: startsAt,
        p_new_professional_id: col.professionalId !== a.professional_id ? col.professionalId : null,
        p_force: false,
      })
      invalidateAll(qc)
      await qc.refetchQueries({ queryKey: ['appointments'] })
      revert()
      snack.show('Agendamento movido')
    } catch (e) {
      revert()
      snack.show(messageOf(e), 'error')
    }
  }

  const step = view === 'dia' ? 1 : 7
  const loading = pros.isLoading || hours.isLoading || appts.isLoading

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <TabList>
          <TabLabel active={view === 'dia'} onClick={() => setView('dia')}>
            Dia
          </TabLabel>
          <TabLabel active={view === 'semana'} onClick={() => setView('semana')}>
            Semana
          </TabLabel>
        </TabList>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="secondary"
            icon={<Lock size={16} />}
            onClick={() => setBlockOpen(true)}
          >
            Bloquear horário
          </Button>
          <Button
            icon={<Plus size={16} />}
            onClick={() => {
              setPrefill({ date })
              setNewOpen(true)
            }}
          >
            Novo agendamento
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" aria-label="Anterior" onClick={() => setDate(addDaysYMD(date, -step, date))}>
          <ChevronLeft size={18} />
        </Button>
        <Button variant="secondary" onClick={() => setDate(todaySP())}>
          Hoje
        </Button>
        <Button variant="secondary" aria-label="Próximo" onClick={() => setDate(addDaysYMD(date, step, date))}>
          <ChevronRight size={18} />
        </Button>
        <div className="w-44">
          <Input type="date" aria-label="Data" value={date} onChange={(e) => isValidYMD(e.target.value) && setDate(e.target.value)} />
        </div>
        <p className="label-caps ml-1">{view === 'dia' ? formatDayLong(date) : `${formatDayShort(from)} – ${formatDayShort(to)}`}</p>
      </div>

      <ChipRow>
        {active.map((p) =>
          view === 'dia' ? (
            <Chip
              key={p.id}
              dot={p.color}
              selected={!hidden.includes(p.id)}
              onClick={() => setHidden((h) => (h.includes(p.id) ? h.filter((x) => x !== p.id) : [...h, p.id]))}
            >
              {toTitlePt(p.name)}
            </Chip>
          ) : (
            <Chip key={p.id} dot={p.color} selected={proForWeek?.id === p.id} onClick={() => setWeekPro(p.id)}>
              {toTitlePt(p.name)}
            </Chip>
          ),
        )}
      </ChipRow>

      {loading ? (
        <Skeleton className="h-96" />
      ) : columns.length === 0 ? (
        <EmptyState title="Nenhuma profissional visível" help="Ative ao menos uma profissional para ver a agenda." />
      ) : (
        <TimeGrid
          // remount when the visible range changes so it can scroll to "now" again
          key={`${view}|${from}`}
          columns={columns}
          bounds={bounds}
          appointments={visibleAppts}
          blocks={blocks.data ?? []}
          onSlotTap={(col, minutes) => {
            setPrefill({ professionalId: col.professionalId, date: col.date, minutes })
            setNewOpen(true)
          }}
          onCardTap={setSelected}
          onBlockTap={setBlockSel}
          onMove={(a, col, min) => void handleMove(a, col, min)}
        />
      )}

      <NewAppointmentSheet open={newOpen} onClose={() => setNewOpen(false)} prefill={prefill} />
      <AppointmentSheet appointment={selected} onClose={() => setSelected(null)} />
      <BlockSheet open={blockOpen} onClose={() => setBlockOpen(false)} date={date} />
      <BlockDetailSheet block={blockSel} onClose={() => setBlockSel(null)} />
    </div>
  )
}

function ToConfirmTab() {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const list = useToConfirm()
  const [selected, setSelected] = useState<{ a: AppointmentRow; mode: SheetMode } | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  async function confirm(a: AppointmentRow) {
    setPendingId(a.id)
    try {
      await rpc.confirmAppointment({ p_appointment_id: a.id })
      invalidateAll(qc)
      snack.show('Agendamento confirmado')
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPendingId(null)
    }
  }

  if (list.isLoading) return <Skeleton className="h-40" />
  const rows = list.data ?? []
  if (rows.length === 0) return <EmptyState title="Nada a confirmar" help="Todos os próximos agendamentos já estão confirmados." />

  return (
    <>
      <ul className="space-y-3">
        {rows.map((a) => (
          <AppointmentListRow
            key={a.id}
            a={a}
            showDate
            onOpen={(x) => setSelected({ a: x, mode: 'view' })}
            actions={
              <>
                <Button loading={pendingId === a.id} onClick={() => void confirm(a)}>
                  Confirmar
                </Button>
                <Button variant="secondary" onClick={() => setSelected({ a, mode: 'reschedule' })}>
                  Reagendar
                </Button>
              </>
            }
          />
        ))}
      </ul>
      <AppointmentSheet appointment={selected?.a ?? null} initialMode={selected?.mode} onClose={() => setSelected(null)} />
    </>
  )
}
