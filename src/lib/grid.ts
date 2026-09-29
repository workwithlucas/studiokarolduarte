// Agenda grid math: minutes <-> pixels, 15-minute snapping, bounds. Pure, no DOM.

export const ROW_MIN = 15
export const ROW_PX = 24
export const PX_PER_MIN = ROW_PX / ROW_MIN
export const FALLBACK_BOUNDS = { startMin: 8 * 60, endMin: 19 * 60 }

export interface Bounds {
  startMin: number
  endMin: number
}

export function minutesToPx(min: number, startMin: number): number {
  return (min - startMin) * PX_PER_MIN
}

export function pxToMinutes(px: number, startMin: number): number {
  return startMin + px / PX_PER_MIN
}

export function snap(min: number, step = ROW_MIN): number {
  return Math.round(min / step) * step
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Snapped start (minutes) for a y offset inside the grid, kept inside the bounds. */
export function slotFromPx(px: number, bounds: Bounds, durationMin = ROW_MIN): number {
  const snapped = snap(pxToMinutes(px, bounds.startMin))
  return clamp(snapped, bounds.startMin, Math.max(bounds.startMin, bounds.endMin - durationMin))
}

export function gridHeightPx(bounds: Bounds): number {
  return (bounds.endMin - bounds.startMin) * PX_PER_MIN
}

/**
 * min/max of the visible professionals' working hours, widened to whole hours so the
 * hour labels line up. Fallback 08:00–19:00 when there are no hours.
 */
export function gridBounds(ranges: ReadonlyArray<{ start: number; end: number }>): Bounds {
  if (ranges.length === 0) return { ...FALLBACK_BOUNDS }
  const start = Math.min(...ranges.map((r) => r.start))
  const end = Math.max(...ranges.map((r) => r.end))
  return { startMin: Math.floor(start / 60) * 60, endMin: Math.ceil(end / 60) * 60 }
}

/** Parts of the bounds not covered by the working ranges (drawn shaded). */
export function nonWorkingSegments(
  ranges: ReadonlyArray<{ start: number; end: number }>,
  bounds: Bounds,
): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  let cursor = bounds.startMin
  for (const r of sorted) {
    const s = clamp(r.start, bounds.startMin, bounds.endMin)
    const e = clamp(r.end, bounds.startMin, bounds.endMin)
    if (s > cursor) out.push({ start: cursor, end: s })
    cursor = Math.max(cursor, e)
  }
  if (cursor < bounds.endMin) out.push({ start: cursor, end: bounds.endMin })
  return out
}
