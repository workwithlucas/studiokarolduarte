import { Check } from 'lucide-react'
import { Pill, type PillTone } from '../../components/ui'
import { usePackageSession } from '../../lib/clientQueries'
import { actionLabel, statusLabel, toTitlePt } from '../../lib/format'
import type { AppointmentRow } from '../../lib/queries'

export const STATUS_TONE: Record<string, PillTone> = {
  scheduled: 'gold',
  confirmed: 'success',
  completed: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
}

export function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_TONE[status] ?? 'neutral'}>
      {status === 'confirmed' && <Check size={12} />}
      {statusLabel(status)}
    </Pill>
  )
}

export function serviceLine(a: AppointmentRow, withAddons = false): string {
  const base = `${toTitlePt(a.service?.name)} · ${actionLabel(a.action)}`
  const addons = a.addons.map((x) => x.addon?.name).filter(Boolean)
  return withAddons && addons.length > 0 ? `${base} · ${addons.join(', ')}` : base
}

/** 'X/N' session position of a package appointment (X among non-cancelled/no_show by starts_at), or null. */
export function usePackageSlot(a: Pick<AppointmentRow, 'id' | 'client_package_id'>): string | null {
  const s = usePackageSession(a.id, a.client_package_id)
  return s.data ? `${s.data.position}/${s.data.total}` : null
}

export function PackagePill({ a }: { a: Pick<AppointmentRow, 'id' | 'client_package_id'> }) {
  const slot = usePackageSlot(a)
  if (!a.client_package_id) return null
  return <Pill tone="primary">{slot ? `Pacote · sessão ${slot}` : 'Pacote'}</Pill>
}
