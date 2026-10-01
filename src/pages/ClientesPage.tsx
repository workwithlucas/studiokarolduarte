import { Plus, Upload } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Button, Chip, ChipRow, EmptyState, Input, Kicker, Pill, Skeleton, TabLabel, TabList } from '../components/ui'
import { NewAppointmentSheet, type Prefill } from '../features/agenda/NewAppointmentSheet'
import { Avatar, dayMonth, SegmentPill, useDebounced, WhatsAppButton } from '../features/clients/common'
import { ImportSheet } from '../features/clients/ImportSheet'
import { NewClientSheet } from '../features/clients/ClientSheets'
import { useClientDirectory, useClientSpend, type ClientDirRow } from '../lib/clientQueries'
import { useClientAccountSummary } from '../lib/financeQueries'
import { todaySP } from '../lib/datetime'
import { formatPhoneBR, toTitlePt } from '../lib/format'
import { formatBRL } from '../lib/money'

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'birthday_month', label: 'Aniversariantes do mês' },
  { key: 'recurring', label: 'Recorrentes' },
  { key: 'new', label: 'Novas' },
  { key: 'inactive', label: 'Inativas' },
]

export function ClientesPage() {
  const { isOwner } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'retornar' ? 'retornar' : 'diretorio'
  const [term, setTerm] = useState('')
  const [filter, setFilter] = useState('all')
  const [newOpen, setNewOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [booking, setBooking] = useState<Prefill | null>(null)

  const query = useDebounced(term, 250)
  const dir = useClientDirectory(tab === 'retornar' ? '' : query, tab === 'retornar' ? 'needs_return' : filter)
  const rows = (dir.data?.pages ?? []).flat()
  const total = dir.data?.pages[0]?.[0]?.total_count ?? 0
  const spend = useClientSpend(
    rows.map((r) => r.client_id),
    isOwner && tab === 'diretorio',
  )

  const accounts = useClientAccountSummary(
    rows.map((r) => r.client_id),
    isOwner && tab === 'diretorio',
  )

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Kicker className="mb-1">{dir.isLoading ? 'Studio' : `${total} ${total === 1 ? 'cliente' : 'clientes'}`}</Kicker>
          <h1 className="title-serif text-3xl">Clientes</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {isOwner && (
            <Button variant="secondary" icon={<Upload size={16} />} onClick={() => setImportOpen(true)}>
              Importar
            </Button>
          )}
          <Button icon={<Plus size={16} />} onClick={() => setNewOpen(true)}>
            Novo cliente
          </Button>
        </div>
      </header>

      <TabList>
        <TabLabel active={tab === 'diretorio'} onClick={() => setParams({})}>
          Diretório
        </TabLabel>
        <TabLabel active={tab === 'retornar'} onClick={() => setParams({ tab: 'retornar' })}>
          A retornar
        </TabLabel>
      </TabList>

      {tab === 'diretorio' && (
        <div className="space-y-3">
          <Input placeholder="Buscar por nome ou telefone" value={term} onChange={(e) => setTerm(e.target.value)} />
          <ChipRow>
            {FILTERS.map((f) => (
              <Chip key={f.key} selected={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.label}
              </Chip>
            ))}
          </ChipRow>
        </div>
      )}

      {dir.isLoading ? (
        <Skeleton className="h-48" />
      ) : rows.length === 0 ? (
        <EmptyState
          title={tab === 'retornar' ? 'Ninguém para retornar agora' : 'Nenhuma cliente encontrada'}
          help={tab === 'retornar' ? 'Clientes sem visita recente e sem novo horário aparecem aqui.' : 'Tente outra busca ou outro filtro.'}
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((c) => (
            <ClientRow
              key={c.client_id}
              c={c}
              returning={tab === 'retornar'}
              spentCents={spend.data?.get(c.client_id)}
              account={accounts.data?.get(c.client_id)}
              showSpend={isOwner && tab === 'diretorio'}
              onBook={() => setBooking({ date: todaySP(), client: { id: c.client_id, name: c.name, phone: c.phone_e164 } })}
            />
          ))}
        </ul>
      )}

      {dir.hasNextPage && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={dir.isFetchingNextPage} onClick={() => void dir.fetchNextPage()}>
            Carregar mais
          </Button>
        </div>
      )}

      <NewClientSheet open={newOpen} onClose={() => setNewOpen(false)} onOpenClient={(id) => navigate(`/clientes/${id}`)} />
      <ImportSheet open={importOpen} onClose={() => setImportOpen(false)} />
      <NewAppointmentSheet open={booking !== null} onClose={() => setBooking(null)} prefill={booking ?? undefined} />
    </div>
  )
}

function ClientRow({
  c,
  returning,
  showSpend,
  spentCents,
  account,
  onBook,
}: {
  c: ClientDirRow
  returning: boolean
  showSpend: boolean
  spentCents: number | undefined
  account: { balance: number; debt: number } | undefined
  onBook: () => void
}) {
  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
      <Link to={`/clientes/${c.client_id}`} className="hit flex items-center gap-4 p-4">
        <Avatar name={c.name} />
        <div className="min-w-0 flex-1">
          <p className="title-serif truncate text-lg">{toTitlePt(c.name)}</p>
          <p className="text-help truncate">{formatPhoneBR(c.phone_e164)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SegmentPill segment={c.segment} />
            <Pill>última {dayMonth(c.last_visit_at)}</Pill>
            <Pill>
              {c.visit_count} {c.visit_count === 1 ? 'visita' : 'visitas'}
            </Pill>
            {returning && c.days_since_last_visit !== null && <Pill tone="warn">há {c.days_since_last_visit} dias</Pill>}
            {showSpend && spentCents !== undefined && <Pill tone="primary">{formatBRL(spentCents)}</Pill>}
            {showSpend && account && account.balance > 0 && <Pill tone="success">Crédito {formatBRL(account.balance)}</Pill>}
            {showSpend && account && account.debt > 0 && <Pill tone="danger">Em aberto {formatBRL(account.debt)}</Pill>}
          </div>
        </div>
      </Link>
      {returning && (
        <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">
          <Button onClick={onBook}>Agendar</Button>
          <WhatsAppButton phone={c.phone_e164} />
        </div>
      )}
    </li>
  )
}
