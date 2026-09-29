import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Button, Chip, ChipRow, EmptyState, Kicker, SectionHeader, Skeleton } from '../components/ui'
import { AppointmentListRow } from '../features/agenda/AppointmentListRow'
import { AppointmentSheet } from '../features/agenda/AppointmentSheet'
import { NewAppointmentSheet } from '../features/agenda/NewAppointmentSheet'
import { formatDayLong, formatTime, todaySP } from '../lib/datetime'
import { firstName, toTitlePt } from '../lib/format'
import { MODE_LABEL, useAgentOverview } from '../lib/agentQueries'
import { useNeedsReturnCount } from '../lib/clientQueries'
import { useAgendaRealtime, useAppointments, useProfessionals, useToConfirm, type AppointmentRow } from '../lib/queries'

export function HomePage() {
  const { professional, isOwner } = useAuth()
  const today = todaySP()
  useAgendaRealtime()

  const pros = useProfessionals()
  const appts = useAppointments(today, today)
  const toConfirm = useToConfirm()
  const needsReturn = useNeedsReturnCount()
  const [filter, setFilter] = useState<string>('all')
  const [selected, setSelected] = useState<AppointmentRow | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  // Professional: own appointments only. Owner: chip filter (default Todas).
  const scopeId = isOwner ? (filter === 'all' ? null : filter) : (professional?.id ?? null)
  const inScope = (a: AppointmentRow) => !scopeId || a.professional_id === scopeId

  const list = (appts.data ?? []).filter(inScope)
  const open = list.filter((a) => a.status === 'scheduled' || a.status === 'confirmed')
  const nowIso = new Date().toISOString()
  const next = open.find((a) => a.starts_at >= nowIso)
  const pendingCount = (toConfirm.data ?? []).filter(inScope).length

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Kicker className="mb-1">{formatDayLong(today)}</Kicker>
          <h1 className="title-serif text-3xl lg:text-4xl">Olá, {firstName(professional?.name)}</h1>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => setNewOpen(true)}>
          Novo agendamento
        </Button>
      </header>

      {isOwner && (
        <ChipRow>
          <Chip selected={filter === 'all'} onClick={() => setFilter('all')}>
            Todas
          </Chip>
          {(pros.data ?? [])
            .filter((p) => p.active)
            .map((p) => (
              <Chip key={p.id} dot={p.color} selected={filter === p.id} onClick={() => setFilter(p.id)}>
                {toTitlePt(p.name)}
              </Chip>
            ))}
        </ChipRow>
      )}

      {isOwner && <AgentCard />}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard kicker="Hoje" loading={appts.isLoading}>
          <p className="title-serif text-4xl">{open.length}</p>
        </StatCard>
        <StatCard kicker="Próximo horário" loading={appts.isLoading}>
          {next ? (
            <>
              <p className="title-serif text-4xl">{formatTime(next.starts_at)}</p>
              <p className="text-help truncate">{toTitlePt(next.client?.name)}</p>
            </>
          ) : (
            <p className="text-help">Sem mais horários hoje</p>
          )}
        </StatCard>
        <StatCard kicker="A confirmar" loading={toConfirm.isLoading}>
          <p className="title-serif text-4xl">{pendingCount}</p>
          <Link to="/agenda?tab=confirmar" className="label-caps hit inline-flex items-center !text-ink underline">
            Ver na agenda
          </Link>
        </StatCard>
        <StatCard kicker="A retornar" loading={needsReturn.isLoading}>
          <p className="title-serif text-4xl">{needsReturn.data ?? 0}</p>
          <Link to="/clientes?tab=retornar" className="label-caps hit inline-flex items-center !text-ink underline">
            Ver clientes
          </Link>
        </StatCard>
      </section>

      <section>
        <SectionHeader>Agenda de hoje</SectionHeader>
        {appts.isLoading ? (
          <Skeleton className="h-32" />
        ) : list.length === 0 ? (
          <EmptyState title="Nenhum agendamento hoje" help="Quando houver horários marcados para hoje, eles aparecem aqui." />
        ) : (
          <ul className="space-y-3">
            {list.map((a) => (
              <AppointmentListRow key={a.id} a={a} onOpen={setSelected} />
            ))}
          </ul>
        )}
      </section>

      <NewAppointmentSheet open={newOpen} onClose={() => setNewOpen(false)} prefill={{ date: today }} />
      <AppointmentSheet appointment={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function StatCard({ kicker, loading, children }: { kicker: string; loading: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-h-32 flex-col gap-1 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card">
      <Kicker>{kicker}</Kicker>
      {loading ? <Skeleton className="mt-2 h-10 w-24" /> : children}
    </div>
  )
}

function AgentCard() {
  const q = useAgentOverview()
  const mode = q.data?.settings.agent_mode
  const count = q.data?.attention.length ?? 0
  return (
    <Link
      to="/agente"
      className="flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card"
    >
      <div>
        <Kicker>Agente</Kicker>
        {q.isLoading || !mode ? (
          <Skeleton className="mt-2 h-8 w-32" />
        ) : (
          <p className="title-serif text-2xl">{MODE_LABEL[mode]}</p>
        )}
      </div>
      <div className="text-right">
        <p className="title-serif text-4xl">{count}</p>
        <p className="text-help">{count === 1 ? "precisa de você" : "precisam de você"}</p>
      </div>
    </Link>
  )
}
