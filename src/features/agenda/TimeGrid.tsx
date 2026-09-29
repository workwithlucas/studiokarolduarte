import { Check } from 'lucide-react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { StatusPill } from './common'
import { minutesOfDaySP, minutesSinceDayStart, minutesToHHMM, todaySP, formatTime, ymdOf } from '../../lib/datetime'
import { actionLabel, safeColor, toTitlePt } from '../../lib/format'
import { clamp, gridHeightPx, minutesToPx, nonWorkingSegments, PX_PER_MIN, ROW_PX, slotFromPx, type Bounds } from '../../lib/grid'
import type { AppointmentRow, Block } from '../../lib/queries'

export interface GridColumn {
  key: string
  date: string
  professionalId: string
  title: string
  subtitle?: string
  color: string
  today: boolean
  ranges: Array<{ start: number; end: number }>
}

interface Props {
  columns: GridColumn[]
  bounds: Bounds
  appointments: AppointmentRow[]
  blocks: Block[]
  onSlotTap: (col: GridColumn, minutes: number) => void
  onCardTap: (a: AppointmentRow) => void
  onBlockTap: (b: Block) => void
  onMove: (a: AppointmentRow, col: GridColumn, startMin: number) => void
}

const COL_MIN_W = 148
const GUTTER_W = 56
const HOLD_MS = 250
const TAP_SLOP = 10

interface Drag {
  a: AppointmentRow
  pointerId: number
  startX: number
  startY: number
  grabY: number
  dur: number
  origCol: string
  origStart: number
  touch: boolean
  active: boolean
  timer?: number
  last: { colKey: string; startMin: number }
}

export function TimeGrid({ columns, bounds, appointments, blocks, onSlotTap, onCardTap, onBlockTap, onMove }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const colRefs = useRef(new Map<string, HTMLDivElement>())
  const dragRef = useRef<Drag | null>(null)
  const tapRef = useRef<{ x: number; y: number; t: number; id: number } | null>(null)
  const [ghost, setGhost] = useState<{ id: string; colKey: string; startMin: number } | null>(null)
  const [nowMin, setNowMin] = useState(() => minutesOfDaySP(new Date()))
  const scrolled = useRef(false)
  const height = gridHeightPx(bounds)

  useEffect(() => {
    const t = window.setInterval(() => setNowMin(minutesOfDaySP(new Date())), 30_000)
    return () => window.clearInterval(t)
  }, [])

  // Auto-scroll to "now" on open when today is visible.
  useEffect(() => {
    if (scrolled.current || !scroller.current) return
    if (columns.some((c) => c.date === todaySP())) {
      scroller.current.scrollTop = Math.max(0, minutesToPx(nowMin, bounds.startMin) - 160)
    }
    scrolled.current = true
  }, [columns, nowMin, bounds.startMin])

  // While a card is being dragged (after the hold), stop the page from scrolling.
  useEffect(() => {
    const block = (e: TouchEvent) => {
      if (dragRef.current?.active) e.preventDefault()
    }
    document.addEventListener('touchmove', block, { passive: false })
    return () => document.removeEventListener('touchmove', block)
  }, [])

  // ---- taps (empty slot / block): Pointer Events, ignores scroll gestures
  function tapDown(e: ReactPointerEvent) {
    tapRef.current = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId }
  }
  function isTap(e: ReactPointerEvent): boolean {
    const t = tapRef.current
    tapRef.current = null
    return !!t && t.id === e.pointerId && Math.hypot(e.clientX - t.x, e.clientY - t.y) < TAP_SLOP && Date.now() - t.t < 700
  }

  // ---- card drag
  function locate(clientX: number): string | null {
    let best: { key: string; dist: number } | null = null
    colRefs.current.forEach((el, key) => {
      const r = el.getBoundingClientRect()
      const dist = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0
      if (!best || dist < best.dist) best = { key, dist }
    })
    return (best as { key: string } | null)?.key ?? null
  }

  function cardDown(e: ReactPointerEvent<HTMLDivElement>, a: AppointmentRow, col: GridColumn, startMin: number) {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    e.stopPropagation()
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const d: Drag = {
      a,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabY: e.clientY - rect.top,
      dur: a.duration_min,
      origCol: col.key,
      origStart: startMin,
      touch: e.pointerType !== 'mouse',
      active: false,
      last: { colKey: col.key, startMin },
    }
    dragRef.current = d
    if (d.touch) {
      d.timer = window.setTimeout(() => {
        if (dragRef.current !== d) return
        d.active = true
        try {
          el.setPointerCapture(d.pointerId)
        } catch {
          /* pointer already gone */
        }
        navigator.vibrate?.(10)
        setGhost({ id: a.id, colKey: col.key, startMin })
      }, HOLD_MS)
    } else {
      el.setPointerCapture(e.pointerId)
    }
  }

  function cardMove(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const moved = Math.hypot(e.clientX - d.startX, e.clientY - d.startY)
    if (!d.active) {
      if (d.touch) {
        if (moved > TAP_SLOP) {
          window.clearTimeout(d.timer)
          dragRef.current = null // the user is scrolling
        }
        return
      }
      if (moved < 4) return
      d.active = true
    }
    const key = locate(e.clientX)
    const el = key ? colRefs.current.get(key) : null
    if (!key || !el) return
    const startMin = slotFromPx(e.clientY - el.getBoundingClientRect().top - d.grabY, bounds, d.dur)
    d.last = { colKey: key, startMin }
    setGhost({ id: d.a.id, colKey: key, startMin })
  }

  function cardUp(e: ReactPointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    window.clearTimeout(d.timer)
    dragRef.current = null
    setGhost(null)
    if (d.active) {
      const target = columns.find((c) => c.key === d.last.colKey)
      if (target && (d.last.colKey !== d.origCol || d.last.startMin !== d.origStart)) onMove(d.a, target, d.last.startMin)
    } else {
      onCardTap(d.a)
    }
  }

  function cardCancel() {
    const d = dragRef.current
    if (d) window.clearTimeout(d.timer)
    dragRef.current = null
    setGhost(null)
  }

  return (
    <div
      ref={scroller}
      className="relative overflow-auto rounded-[var(--radius-card)] border border-line bg-surface shadow-card"
      style={{ height: 'calc(100dvh - 290px)', minHeight: 420 }}
    >
      <div className="flex" style={{ minWidth: GUTTER_W + columns.length * COL_MIN_W }}>
        {/* hour labels */}
        <div className="sticky left-0 z-30 shrink-0 bg-surface" style={{ width: GUTTER_W }}>
          <div className="sticky top-0 z-30 h-14 border-b border-line bg-surface" />
          <div className="relative" style={{ height }}>
            {Array.from({ length: Math.ceil((bounds.endMin - bounds.startMin) / 60) }, (_, i) => (
              <span
                key={i}
                className="label-caps absolute right-2"
                style={{ top: minutesToPx(bounds.startMin + i * 60, bounds.startMin) + 2 }}
              >
                {minutesToHHMM(bounds.startMin + i * 60)}
              </span>
            ))}
          </div>
        </div>

        {columns.map((col) => {
          const segs = nonWorkingSegments(col.ranges, bounds)
          const colAppts = appointments.filter((a) => a.professional_id === col.professionalId && ymdOf(a.starts_at) === col.date)
          const colBlocks = blocks.filter((b) => b.professional_id === null || b.professional_id === col.professionalId)
          return (
            <div key={col.key} className="min-w-0 flex-1 border-l border-line" style={{ minWidth: COL_MIN_W }}>
              <div
                className={`sticky top-0 z-20 flex h-14 flex-col justify-center border-b border-line px-3 ${
                  col.today ? 'bg-gold/20' : 'bg-surface'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: safeColor(col.color) }} />
                  <span className={col.subtitle ? 'label-caps truncate' : 'title-serif truncate text-base'}>{col.title}</span>
                </span>
                {col.subtitle && <span className="title-serif truncate text-lg leading-tight">{col.subtitle}</span>}
              </div>

              <div
                ref={(el) => {
                  if (el) colRefs.current.set(col.key, el)
                  else colRefs.current.delete(col.key)
                }}
                className="relative"
                style={{
                  height,
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${ROW_PX * 4 - 1}px, #EFE3DA ${ROW_PX * 4 - 1}px ${ROW_PX * 4}px), repeating-linear-gradient(to bottom, transparent 0 ${ROW_PX - 1}px rgb(239 227 218 / 0.45) ${ROW_PX - 1}px ${ROW_PX}px)`,
                }}
                onPointerDown={tapDown}
                onPointerUp={(e) => {
                  if (!isTap(e)) return
                  const y = e.clientY - e.currentTarget.getBoundingClientRect().top
                  onSlotTap(col, slotFromPx(y - ROW_PX / 2, bounds))
                }}
                onPointerCancel={() => (tapRef.current = null)}
              >
                {segs.map((s) => (
                  <div
                    key={s.start}
                    className="pointer-events-none absolute inset-x-0 bg-ink/[0.06]"
                    style={{ top: minutesToPx(s.start, bounds.startMin), height: (s.end - s.start) * PX_PER_MIN }}
                  />
                ))}

                {colBlocks.map((b) => {
                  const s = clamp(minutesSinceDayStart(col.date, b.starts_at), bounds.startMin, bounds.endMin)
                  const en = clamp(minutesSinceDayStart(col.date, b.ends_at), bounds.startMin, bounds.endMin)
                  if (en <= s) return null
                  return (
                    <div
                      key={b.id}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => {
                        e.stopPropagation()
                        tapDown(e)
                      }}
                      onPointerUp={(e) => {
                        e.stopPropagation()
                        if (isTap(e)) onBlockTap(b)
                      }}
                      onPointerCancel={() => (tapRef.current = null)}
                      className="absolute inset-x-0 overflow-hidden px-2 py-1 text-[11px] text-muted"
                      style={{
                        top: minutesToPx(s, bounds.startMin),
                        height: (en - s) * PX_PER_MIN,
                        backgroundImage:
                          'repeating-linear-gradient(45deg, rgb(139 123 127 / 0.16) 0 6px, rgb(139 123 127 / 0.05) 6px 12px)',
                      }}
                    >
                      <span className="label-caps">{b.reason || 'Bloqueado'}</span>
                    </div>
                  )
                })}

                {colAppts.map((a) => {
                  const startMin = minutesSinceDayStart(col.date, a.starts_at)
                  const top = minutesToPx(startMin, bounds.startMin)
                  const h = Math.max(a.duration_min * PX_PER_MIN, ROW_PX) - 2
                  const color = safeColor(a.professional?.color ?? col.color)
                  const isGhosted = ghost?.id === a.id
                  return (
                    <div
                      key={a.id}
                      role="button"
                      tabIndex={0}
                      onPointerDown={(e) => cardDown(e, a, col, startMin)}
                      onPointerMove={cardMove}
                      onPointerUp={cardUp}
                      onPointerCancel={cardCancel}
                      onContextMenu={(e) => e.preventDefault()}
                      className={`absolute inset-x-1 select-none overflow-hidden rounded-lg px-2 py-0.5 ${
                        a.status === 'completed' ? 'opacity-55' : ''
                      } ${isGhosted ? 'opacity-40' : ''}`}
                      style={{
                        top: top + 1,
                        height: h,
                        backgroundColor: `${color}2E`,
                        borderLeft: `4px solid ${color}`,
                        WebkitTouchCallout: 'none',
                        cursor: 'grab',
                      }}
                    >
                      <CardContent a={a} h={h} />
                    </div>
                  )
                })}

                {ghost && ghost.colKey === col.key && (
                  <GhostCard
                    a={appointments.find((x) => x.id === ghost.id)}
                    startMin={ghost.startMin}
                    bounds={bounds}
                  />
                )}

                {col.today && nowMin >= bounds.startMin && nowMin <= bounds.endMin && (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger"
                    style={{ top: minutesToPx(nowMin, bounds.startMin) }}
                  >
                    <span className="absolute -left-1 -top-[5px] size-2 rounded-full bg-danger" />
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function CardContent({ a, h }: { a: AppointmentRow; h: number }) {
  const range = `${formatTime(a.starts_at)}–${formatTime(a.ends_at)}`
  const client = toTitlePt(a.client?.name)
  const svc = `${toTitlePt(a.service?.name)} · ${actionLabel(a.action)}`
  const check = a.status === 'confirmed' && <Check size={12} className="shrink-0 text-success" aria-label="Confirmado" />

  if (h < 40) {
    return (
      <p className="flex items-center gap-1 whitespace-nowrap text-[11px] leading-[20px]">
        <span className="text-muted">{formatTime(a.starts_at)}</span>
        <span className="title-serif truncate text-[13px]">{client}</span>
        {check}
      </p>
    )
  }
  return (
    <div className="flex h-full flex-col">
      <p className="flex items-center justify-between gap-1 text-[10px] leading-4 text-muted">
        <span>{range}</span>
        {check}
      </p>
      <p className="title-serif truncate text-[15px] leading-5">{client}</p>
      {h >= 64 && <p className="truncate text-[11px] leading-4 text-muted">{svc}</p>}
      {h >= 92 && (
        <div className="mt-auto pb-1">
          <StatusPill status={a.status} />
        </div>
      )}
    </div>
  )
}

function GhostCard({ a, startMin, bounds }: { a?: AppointmentRow; startMin: number; bounds: Bounds }) {
  if (!a) return null
  const color = safeColor(a.professional?.color)
  return (
    <div
      className="pointer-events-none absolute inset-x-1 z-20 rounded-lg border-2 border-dashed px-2 py-0.5 text-[11px]"
      style={{
        top: minutesToPx(startMin, bounds.startMin) + 1,
        height: Math.max(a.duration_min * PX_PER_MIN, ROW_PX) - 2,
        borderColor: color,
        backgroundColor: `${color}40`,
      }}
    >
      {minutesToHHMM(startMin)}–{minutesToHHMM(startMin + a.duration_min)}
    </div>
  )
}
