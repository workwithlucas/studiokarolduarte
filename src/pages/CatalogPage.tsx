import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { Button, EmptyState, Kicker, SectionHeader, Skeleton, TabLabel, TabList, useSnackbar } from '../components/ui'
import { AddonManagerSheet } from '../features/catalog/AddonManager'
import { ServiceFormSheet } from '../features/catalog/ServiceForm'
import { ServiceCard } from '../features/catalog/ServiceCard'
import { invalidateCatalog, useServices, type Service } from '../lib/queries'
import { messageOf, rpc } from '../lib/rpc'

const TABS: Array<{ key: string; label: string }> = [
  { key: 'todos', label: 'Todos' },
  { key: 'unhas', label: 'Unhas' },
  { key: 'cilios', label: 'Cílios' },
  { key: 'sobrancelhas', label: 'Sobrancelhas' },
  { key: 'outros', label: 'Outros' },
]

export function CatalogPage() {
  const { isOwner } = useAuth()
  const qc = useQueryClient()
  const snack = useSnackbar()
  const services = useServices()
  const [tab, setTab] = useState('todos')
  const [editing, setEditing] = useState<Service | 'new' | null>(null)
  const [addonsFor, setAddonsFor] = useState<Service | null>(null)

  const inTab = (services.data ?? []).filter((s) => tab === 'todos' || s.category === tab)
  const standard = inTab.filter((s) => s.kind === 'standard')
  const removal = inTab.filter((s) => s.kind === 'removal')

  async function toggle(s: Service, active: boolean) {
    try {
      await rpc.upsertService({
        p_id: s.id,
        p_name: s.name,
        p_category: s.category,
        p_kind: s.kind,
        p_duration_min: s.duration_min,
        p_price_cents: s.price_cents,
        p_maintenance_duration_min: s.maintenance_duration_min,
        p_maintenance_price_cents: s.maintenance_price_cents,
        p_cash_price_cents: s.cash_price_cents,
        p_active: active,
      })
      invalidateCatalog(qc)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    }
  }

  const list = (rows: Service[]) => (
    <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((s) => (
        <ServiceCard key={s.id} service={s} canEdit={isOwner} onToggle={toggle} onEdit={setEditing} onAddons={setAddonsFor} />
      ))}
    </ul>
  )

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Kicker className="mb-1">Studio</Kicker>
          <h1 className="title-serif text-3xl">Catálogo</h1>
        </div>
        {isOwner && (
          <Button icon={<Plus size={16} />} onClick={() => setEditing('new')}>
            Novo serviço
          </Button>
        )}
      </header>

      <TabList>
        {TABS.map((t) => (
          <TabLabel key={t.key} active={tab === t.key} onClick={() => setTab(t.key)}>
            {t.label}
          </TabLabel>
        ))}
      </TabList>

      {services.isLoading ? (
        <Skeleton className="h-48" />
      ) : inTab.length === 0 ? (
        <EmptyState title="Nenhum serviço aqui" help={isOwner ? 'Cadastre o primeiro serviço desta categoria.' : undefined} />
      ) : (
        <>
          {standard.length > 0 && list(standard)}
          {removal.length > 0 && (
            <section>
              <SectionHeader>Remoção · avulso</SectionHeader>
              {list(removal)}
            </section>
          )}
        </>
      )}

      <ServiceFormSheet open={editing !== null} service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      <AddonManagerSheet service={addonsFor} canEdit={isOwner} onClose={() => setAddonsFor(null)} />
    </div>
  )
}
