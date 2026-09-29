import { useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Button, Chip, ChipRow, EmptyState, Input, Kicker, Pill, Skeleton, TabLabel, TabList, Toggle, useSnackbar, type PillTone } from '../components/ui'
import { useDebounced } from '../features/clients/common'
import { SellPackageSheet, TemplateSheet } from '../features/packages/PackageSheets'
import { useAllPackages, usePackageTemplates, type PackageTemplate } from '../lib/clientQueries'
import { formatDate } from '../lib/datetime'
import { toTitlePt } from '../lib/format'
import { formatBRL } from '../lib/money'
import { invalidateAll, useServices } from '../lib/queries'
import { messageOf, rpc } from '../lib/rpc'

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  active: { label: 'Ativo', tone: 'success' },
  expired: { label: 'Vencido', tone: 'warn' },
  exhausted: { label: 'Esgotado', tone: 'neutral' },
}

function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function PacotesPage() {
  const { isOwner } = useAuth()
  const [tab, setTab] = useState<'modelos' | 'ativos'>('modelos')
  const [sellOpen, setSellOpen] = useState(false)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Kicker className="mb-1">Studio</Kicker>
          <h1 className="title-serif text-3xl">Pacotes</h1>
        </div>
        {tab === 'ativos' && (
          <Button icon={<Plus size={16} />} onClick={() => setSellOpen(true)}>
            Vender pacote
          </Button>
        )}
      </header>

      <TabList>
        <TabLabel active={tab === 'modelos'} onClick={() => setTab('modelos')}>
          Modelos
        </TabLabel>
        <TabLabel active={tab === 'ativos'} onClick={() => setTab('ativos')}>
          Ativos
        </TabLabel>
      </TabList>

      {tab === 'modelos' ? <Templates canEdit={isOwner} /> : <Active canVoid={isOwner} />}
      <SellPackageSheet open={sellOpen} onClose={() => setSellOpen(false)} />
    </div>
  )
}

function Templates({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const templates = usePackageTemplates()
  const services = useServices()
  const [editing, setEditing] = useState<PackageTemplate | 'new' | null>(null)

  async function toggle(t: PackageTemplate, active: boolean) {
    try {
      await rpc.upsertPackageTemplate({
        p_id: t.id,
        p_name: t.name,
        p_service_id: t.service_id,
        p_sessions_total: t.sessions_total,
        p_validity_days: t.validity_days,
        p_price_cents: t.price_cents,
        p_active: active,
      })
      invalidateAll(qc)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    }
  }

  return (
    <section className="space-y-4">
      {canEdit && (
        <div>
          <Button icon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Novo modelo
          </Button>
        </div>
      )}
      {templates.isLoading ? (
        <Skeleton className="h-40" />
      ) : (templates.data ?? []).length === 0 ? (
        <EmptyState title="Nenhum modelo de pacote" help={canEdit ? 'Crie o primeiro modelo para poder vender pacotes.' : undefined} />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(templates.data ?? []).map((t) => (
            <li key={t.id} className={`rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card ${t.active ? '' : 'opacity-60'}`}>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="title-serif text-xl">{toTitlePt(t.name)}</h3>
                  <p className="text-help">{toTitlePt(services.data?.find((s) => s.id === t.service_id)?.name)}</p>
                </div>
                <Toggle label={`Ativar ${t.name}`} checked={t.active} disabled={!canEdit} onChange={(v) => void toggle(t, v)} />
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                <Pill>{t.sessions_total} sessões</Pill>
                <Pill>{t.validity_days} dias</Pill>
                {!t.active && <Pill tone="warn">Inativo</Pill>}
              </div>
              <p className="title-serif text-2xl">{formatBRL(t.price_cents)}</p>
              {canEdit && (
                <div className="mt-4">
                  <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => setEditing(t)}>
                    Editar
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <TemplateSheet open={editing !== null} template={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
    </section>
  )
}

function Active({ canVoid }: { canVoid: boolean }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const all = useAllPackages()
  const [status, setStatus] = useState<string>('all')
  const [term, setTerm] = useState('')
  const debounced = useDebounced(fold(term.trim()), 250)
  const [voiding, setVoiding] = useState<string | null>(null)

  const rows = useMemo(
    () =>
      (all.data ?? []).filter(
        (r) => (status === 'all' || r.status === status) && (!debounced || fold(r.client_name).includes(debounced)),
      ),
    [all.data, status, debounced],
  )

  async function voidPackage(id: string) {
    setVoiding(id)
    try {
      await rpc.voidPackage({ p_client_package_id: id })
      invalidateAll(qc)
      snack.show('Pacote anulado')
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setVoiding(null)
    }
  }

  return (
    <section className="space-y-4">
      <ChipRow>
        {[
          ['all', 'Todos'],
          ['active', 'Ativos'],
          ['expired', 'Vencidos'],
          ['exhausted', 'Esgotados'],
        ].map(([k, label]) => (
          <Chip key={k} selected={status === k} onClick={() => setStatus(k!)}>
            {label}
          </Chip>
        ))}
      </ChipRow>
      <Input placeholder="Buscar cliente" value={term} onChange={(e) => setTerm(e.target.value)} />

      {all.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nenhum pacote" help="Ajuste os filtros ou venda um pacote." />
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => {
            const st = STATUS[r.status] ?? STATUS.active!
            return (
              <li key={r.client_package_id} className="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <Link to={`/clientes/${r.client_id}`} className="title-serif block truncate text-lg">
                      {toTitlePt(r.client_name)}
                    </Link>
                    <p className="text-help">{toTitlePt(r.template_name)}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill>
                      restantes {r.remaining}/{r.sessions_total}
                    </Pill>
                    <Pill>vence {formatDate(r.expires_at)}</Pill>
                    <Pill tone={st.tone}>{st.label}</Pill>
                    {canVoid && (
                      <Button variant="danger" loading={voiding === r.client_package_id} onClick={() => void voidPackage(r.client_package_id)}>
                        Anular
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
