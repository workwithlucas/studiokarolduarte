import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Button, EmptyState, Kicker, Pill, SectionHeader, Skeleton, Toggle, useSnackbar } from '../components/ui'
import { AppointmentSheet } from '../features/agenda/AppointmentSheet'
import { serviceLine, StatusPill } from '../features/agenda/common'
import { NewAppointmentSheet } from '../features/agenda/NewAppointmentSheet'
import { Avatar, dayMonth, SegmentPill, WhatsAppButton } from '../features/clients/common'
import { EditClientSheet } from '../features/clients/ClientSheets'
import { SellPackageSheet } from '../features/packages/PackageSheets'
import { useClientContext, useClientHistory, useClientPackages, useClientRow, useClientUpcoming } from '../lib/clientQueries'
import { formatDate, formatDayShort, formatTime, todaySP, ymdOf } from '../lib/datetime'
import { formatPhoneBR, toTitlePt } from '../lib/format'
import { formatBRL } from '../lib/money'
import { invalidateAll, useProfessionals, type AppointmentRow } from '../lib/queries'
import { messageOf, rpc } from '../lib/rpc'

export function ClientPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const snack = useSnackbar()
  const { isOwner } = useAuth()
  const row = useClientRow(id)
  const ctx = useClientContext(id)
  const upcoming = useClientUpcoming(id)
  const history = useClientHistory(id)
  const packages = useClientPackages(id)
  const pros = useProfessionals()

  const [selected, setSelected] = useState<AppointmentRow | null>(null)
  const [bookOpen, setBookOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [sellOpen, setSellOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)

  if (row.isLoading) return <Skeleton className="h-48" />
  const c = row.data
  if (!c) {
    return (
      <EmptyState
        title="Cliente não encontrada"
        action={
          <Button variant="secondary" onClick={() => navigate('/clientes')}>
            Voltar para Clientes
          </Button>
        }
      />
    )
  }

  const picked = { id: c.id, name: c.name, phone: c.phone_e164 }
  const proName = (pid: string | null | undefined) => toTitlePt(pros.data?.find((p) => p.id === pid)?.name)
  const activePackages = (packages.data ?? []).filter((p) => p.status === 'active')
  const rows = (history.data?.pages ?? []).flat()

  async function setArchived(next: boolean) {
    setArchiving(true)
    try {
      await rpc.updateClient({
        p_client_id: c!.id,
        p_name: c!.name,
        p_phone: c!.phone_e164,
        p_birthday: c!.birthday,
        p_notes: c!.notes,
        p_archived: next,
      })
      invalidateAll(qc)
      snack.show(next ? 'Cliente arquivada' : 'Cliente reativada')
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="space-y-8">
      <Link to="/clientes" className="label-caps hit inline-flex items-center gap-2 !text-muted">
        <ArrowLeft size={16} />
        Clientes
      </Link>

      <header className="space-y-4 pt-[env(safe-area-inset-top)]">
        <div className="flex items-center gap-4">
          <Avatar name={c.name} />
          <div className="min-w-0">
            <h1 className="title-serif text-3xl">{toTitlePt(c.name)}</h1>
            <p className="text-help">
              {formatPhoneBR(c.phone_e164)}
              {c.birthday ? ` · ${dayMonth(c.birthday)}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ctx.data && <SegmentPill segment={ctx.data.segment} />}
          {ctx.data?.needs_return && <Pill tone="warn">A retornar</Pill>}
          {c.archived && <Pill tone="danger">Arquivada</Pill>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Plus size={16} />} onClick={() => setBookOpen(true)}>
            Novo agendamento
          </Button>
          <WhatsAppButton phone={c.phone_e164} />
          <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => setEditOpen(true)}>
            Editar
          </Button>
          <div className="flex items-center gap-2">
            <span className="label-caps">Arquivar</span>
            <Toggle label="Arquivar cliente" checked={c.archived} disabled={archiving} onChange={(v) => void setArchived(v)} />
          </div>
        </div>
      </header>

      <section>
        <SectionHeader>Resumo</SectionHeader>
        {ctx.isLoading ? (
          <Skeleton className="h-24" />
        ) : ctx.data ? (
          <div className="grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Kicker>Última visita</Kicker>
              <p className="title-serif text-xl">{ctx.data.last_visit_at ? formatDate(ctx.data.last_visit_at) : 'Ainda não veio'}</p>
            </div>
            <div>
              <Kicker>Visitas</Kicker>
              <p className="title-serif text-xl">{ctx.data.visit_count}</p>
            </div>
            <div>
              <Kicker>Habitual</Kicker>
              {ctx.data.professional_ranking.length === 0 ? (
                <p className="text-help">—</p>
              ) : (
                <ul>
                  {ctx.data.professional_ranking.map((r, i) => (
                    <li key={r.professional_id} className={i === 0 ? 'title-serif text-xl' : 'text-help'}>
                      {proName(r.professional_id)} · {r.visits}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {isOwner && typeof ctx.data.total_spent_cents === 'number' && (
              <div>
                <Kicker>Gasto total</Kicker>
                <p className="title-serif text-xl">{formatBRL(Number(ctx.data.total_spent_cents))}</p>
              </div>
            )}
          </div>
        ) : null}
      </section>

      <section>
        <SectionHeader>Próximos agendamentos</SectionHeader>
        {(upcoming.data ?? []).length === 0 ? (
          <p className="text-help">Nenhum agendamento futuro.</p>
        ) : (
          <ul className="space-y-2">
            {(upcoming.data ?? []).map((a) => (
              <ApptLine key={a.id} a={a} onOpen={setSelected} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader>Histórico</SectionHeader>
        {history.isLoading ? (
          <Skeleton className="h-24" />
        ) : rows.length === 0 ? (
          <p className="text-help">Nenhum atendimento ainda.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((a) => (
              <ApptLine key={a.id} a={a} onOpen={setSelected} muted={a.status === 'cancelled' || a.status === 'no_show'} />
            ))}
          </ul>
        )}
        {history.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button variant="secondary" loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              Carregar mais
            </Button>
          </div>
        )}
      </section>

      <section>
        <SectionHeader
          action={
            <Button variant="secondary" onClick={() => setSellOpen(true)}>
              Vender pacote
            </Button>
          }
        >
          Pacotes ativos
        </SectionHeader>
        {activePackages.length === 0 ? (
          <p className="text-help">Nenhum pacote ativo.</p>
        ) : (
          <ul className="space-y-2">
            {activePackages.map((p) => (
              <li key={p.client_package_id} className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                <p className="title-serif text-lg">{toTitlePt(p.template_name)}</p>
                <div className="flex gap-2">
                  <Pill>
                    restantes {p.remaining}/{p.sessions_total}
                  </Pill>
                  <Pill>vence {formatDate(p.expires_at)}</Pill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader>Notas</SectionHeader>
        {c.notes ? <p className="whitespace-pre-line text-base">{c.notes}</p> : <p className="text-help">Sem notas.</p>}
      </section>

      <NewAppointmentSheet open={bookOpen} onClose={() => setBookOpen(false)} prefill={{ date: todaySP(), client: picked }} />
      <AppointmentSheet appointment={selected} onClose={() => setSelected(null)} />
      <EditClientSheet clientId={c.id} open={editOpen} onClose={() => setEditOpen(false)} />
      <SellPackageSheet open={sellOpen} client={picked} onClose={() => setSellOpen(false)} />
    </div>
  )
}

function ApptLine({ a, onOpen, muted }: { a: AppointmentRow; onOpen: (a: AppointmentRow) => void; muted?: boolean }) {
  return (
    <li className={muted ? 'opacity-60' : ''}>
      <button
        type="button"
        onClick={() => onOpen(a)}
        className="hit flex w-full items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3 text-left"
      >
        <div className="min-w-0">
          <p className="title-serif text-lg">
            {formatDayShort(ymdOf(a.starts_at))} · {formatTime(a.starts_at)}
          </p>
          <p className="text-help truncate">
            {serviceLine(a)} · {toTitlePt(a.professional?.name)}
          </p>
        </div>
        <StatusPill status={a.status} />
      </button>
    </li>
  )
}
