import { Pencil } from 'lucide-react'
import { Button, Kicker, Pill, Toggle } from '../../components/ui'
import { formatDuration, toTitlePt } from '../../lib/format'
import { formatBRL } from '../../lib/money'
import type { Service } from '../../lib/queries'

function PriceRow({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <Kicker>{label}</Kicker>
      <p className="text-right text-base">
        {value}
        {extra && <span className="text-help"> · {extra}</span>}
      </p>
    </div>
  )
}

export function ServiceCard({
  service: s,
  canEdit,
  onToggle,
  onEdit,
  onAddons,
}: {
  service: Service
  canEdit: boolean
  onToggle: (s: Service, next: boolean) => void
  onEdit: (s: Service) => void
  onAddons: (s: Service) => void
}) {
  const removal = s.kind === 'removal'
  return (
    <li className={`rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card ${s.active ? '' : 'opacity-60'}`}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="title-serif text-xl">{toTitlePt(s.name)}</h3>
          <div className="mt-2 flex gap-2">
            <Pill>{formatDuration(s.duration_min)}</Pill>
            {!s.active && <Pill tone="warn">Inativo</Pill>}
          </div>
        </div>
        <Toggle label={`Ativar ${s.name}`} checked={s.active} disabled={!canEdit} onChange={(v) => onToggle(s, v)} />
      </div>

      <div className="space-y-2">
        <PriceRow label={removal ? 'Remoção' : 'Colocação'} value={formatBRL(s.price_cents)} />
        {!removal && s.maintenance_price_cents !== null && (
          <PriceRow
            label="Manutenção"
            value={formatBRL(s.maintenance_price_cents)}
            extra={formatDuration(s.maintenance_duration_min)}
          />
        )}
        {s.cash_price_cents !== null && <PriceRow label="À vista" value={formatBRL(s.cash_price_cents)} />}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => onAddons(s)}>
          Adicionais
        </Button>
        {canEdit && (
          <Button variant="secondary" icon={<Pencil size={16} />} onClick={() => onEdit(s)}>
            Editar
          </Button>
        )}
      </div>
    </li>
  )
}
