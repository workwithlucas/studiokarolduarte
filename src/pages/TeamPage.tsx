import { useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Button, EmptyState, Kicker, Pill, Skeleton, Toggle, useSnackbar } from '../components/ui'
import { CommissionSheet } from '../features/team/CommissionSheet'
import { ProfessionalFormSheet, ProfessionalServicesSheet, WorkingHoursSheet } from '../features/team/TeamSheets'
import { safeColor, toTitlePt } from '../lib/format'
import { invalidateCatalog, useProfessionals, useProfessionalServices, type Professional } from '../lib/queries'
import { messageOf, RpcError, rpc } from '../lib/rpc'

export function TeamPage() {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const pros = useProfessionals()
  const links = useProfessionalServices()
  const [form, setForm] = useState<Professional | 'new' | null>(null)
  const [servicesFor, setServicesFor] = useState<Professional | null>(null)
  const [hoursFor, setHoursFor] = useState<Professional | null>(null)
  const [commissionFor, setCommissionFor] = useState<Professional | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  async function setActive(p: Professional, active: boolean) {
    setErrors((e) => ({ ...e, [p.id]: '' }))
    try {
      await rpc.upsertProfessional({ p_id: p.id, p_name: p.name, p_color: p.color, p_active: active })
      invalidateCatalog(qc)
    } catch (e) {
      const msg = messageOf(e)
      if (e instanceof RpcError && e.code === 'HAS_USAGE') setErrors((cur) => ({ ...cur, [p.id]: msg }))
      snack.show(msg, 'error')
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Kicker className="mb-1">Studio</Kicker>
          <h1 className="title-serif text-3xl">Equipe</h1>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => setForm('new')}>
          Novo profissional
        </Button>
      </header>

      {pros.isLoading ? (
        <Skeleton className="h-48" />
      ) : (pros.data ?? []).length === 0 ? (
        <EmptyState title="Nenhuma profissional" />
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(pros.data ?? []).map((p) => {
            const count = (links.data ?? []).filter((l) => l.professional_id === p.id).length
            return (
              <li
                key={p.id}
                className={`rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card ${p.active ? '' : 'opacity-60'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="size-8 shrink-0 rounded-full" style={{ backgroundColor: safeColor(p.color) }} />
                    <div className="min-w-0">
                      <h3 className="title-serif truncate text-xl">{toTitlePt(p.name)}</h3>
                      <div className="mt-1 flex gap-2">
                        <Pill tone={p.role === 'owner' ? 'gold' : 'neutral'}>{p.role === 'owner' ? 'Proprietária' : 'Profissional'}</Pill>
                        {!p.active && <Pill tone="warn">Inativa</Pill>}
                      </div>
                    </div>
                  </div>
                  <Toggle label={`Ativar ${p.name}`} checked={p.active} onChange={(v) => void setActive(p, v)} />
                </div>
                {errors[p.id] && (
                  <p role="alert" className="text-help mt-3 !text-danger">
                    {errors[p.id]}
                  </p>
                )}
                <p className="text-help mt-3">
                  {count} {count === 1 ? 'serviço vinculado' : 'serviços vinculados'}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setServicesFor(p)}>
                    Serviços
                  </Button>
                  <Button variant="secondary" onClick={() => setHoursFor(p)}>
                    Horários
                  </Button>
                  <Button variant="secondary" onClick={() => setCommissionFor(p)}>
                    Comissão
                  </Button>
                  <Button variant="secondary" onClick={() => setForm(p)}>
                    Editar
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <ProfessionalFormSheet open={form !== null} pro={form === 'new' ? null : form} onClose={() => setForm(null)} />
      <ProfessionalServicesSheet pro={servicesFor} onClose={() => setServicesFor(null)} />
      <WorkingHoursSheet pro={hoursFor} onClose={() => setHoursFor(null)} />
      <CommissionSheet pro={commissionFor} onClose={() => setCommissionFor(null)} />
    </div>
  )
}
