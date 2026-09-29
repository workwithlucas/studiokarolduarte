import type { ReactNode } from 'react'
import { Pill } from '../../components/ui'
import { formatDayShort, formatTime, ymdOf } from '../../lib/datetime'
import { toTitlePt } from '../../lib/format'
import type { AppointmentRow } from '../../lib/queries'
import { serviceLine, StatusPill } from './common'

/** One appointment as a list row: time, client, service·action, professional pill, status pill. */
export function AppointmentListRow({
  a,
  onOpen,
  showDate,
  actions,
}: {
  a: AppointmentRow
  onOpen: (a: AppointmentRow) => void
  showDate?: boolean
  actions?: ReactNode
}) {
  return (
    <li className="rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
      <button type="button" onClick={() => onOpen(a)} className="hit flex w-full items-center gap-4 p-4 text-left">
        <div className="w-16 shrink-0">
          <p className="title-serif text-xl">{formatTime(a.starts_at)}</p>
          {showDate && <p className="label-caps">{formatDayShort(ymdOf(a.starts_at))}</p>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="title-serif truncate text-lg">{toTitlePt(a.client?.name)}</p>
          <p className="text-help truncate">{serviceLine(a)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Pill color={a.professional?.color}>{toTitlePt(a.professional?.name)}</Pill>
            <StatusPill status={a.status} />
          </div>
        </div>
      </button>
      {actions && <div className="flex flex-wrap gap-2 border-t border-line px-4 py-3">{actions}</div>}
    </li>
  )
}
