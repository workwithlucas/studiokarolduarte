import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Input, Pill, Skeleton } from '../../components/ui'
import { formatDayShort, formatTime, ymdOf } from '../../lib/datetime'
import { normalizeSearchQuery, type SearchHit } from '../../lib/editAppointment'
import { toTitlePt, statusLabel } from '../../lib/format'
import { useAgendaSearch } from '../../lib/queries'
import { messageOf } from '../../lib/rpc'
import { LocalBoundary } from './AdjustTime'
import { STATUS_TONE } from './common'

const DEBOUNCE_MS = 250

/** Search bar for the top of the agenda: client name (any accent/case, partial) or phone digits. */
export function AgendaSearch({ onPick }: { onPick: (hit: SearchHit & { appointmentId: string; startsAt: string }) => void }) {
  return (
    <LocalBoundary>
      <Inner onPick={onPick} />
    </LocalBoundary>
  )
}

function Inner({ onPick }: { onPick: (hit: SearchHit & { appointmentId: string; startsAt: string }) => void }) {
  const [text, setText] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [text])

  const query = normalizeSearchQuery(debounced)
  const result = useAgendaSearch(query)
  const typing = normalizeSearchQuery(text) !== null && text !== debounced

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={16} aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
        <Input
          type="search"
          role="searchbox"
          aria-label="Buscar cliente na agenda"
          placeholder="Buscar cliente ou telefone"
          autoComplete="off"
          className="pl-11"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setText('')
          }}
        />
      </div>
      {query && (
        <div aria-live="polite">
          {result.isLoading || typing ? (
            <Skeleton className="h-14" />
          ) : result.isError ? (
            <p role="alert" className="text-help !text-danger">
              {messageOf(result.error)}
            </p>
          ) : (result.data ?? []).length === 0 ? (
            <p className="text-help">Nenhuma cliente encontrada.</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card">
              {(result.data ?? []).map((h) => (
                <li key={`${h.clientId}|${h.appointmentId ?? 'none'}`}>
                  {h.appointmentId && h.startsAt ? (
                    <button
                      type="button"
                      className="hit flex w-full items-center gap-3 px-4 py-3 text-left"
                      onClick={() => onPick({ ...h, appointmentId: h.appointmentId!, startsAt: h.startsAt! })}
                    >
                      <div className="w-20 shrink-0">
                        <p className="title-serif text-lg">{formatTime(h.startsAt)}</p>
                        <p className="label-caps">{formatDayShort(ymdOf(h.startsAt))}</p>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="title-serif truncate text-lg">{toTitlePt(h.clientName)}</p>
                        <p className="text-help truncate">
                          {toTitlePt(h.serviceName)} · {toTitlePt(h.professionalName)}
                        </p>
                      </div>
                      <Pill tone={STATUS_TONE[h.status] ?? 'neutral'}>{statusLabel(h.status)}</Pill>
                    </button>
                  ) : (
                    <div className="flex items-center justify-between gap-3 px-4 py-3">
                      <p className="title-serif truncate text-lg">{toTitlePt(h.clientName)}</p>
                      <p className="text-help shrink-0">Sem agendamentos</p>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
