import { describe, expect, it } from 'vitest'
import { FALLBACK_BOUNDS, gridBounds, gridHeightPx, minutesToPx, nonWorkingSegments, pxToMinutes, slotFromPx, snap } from './grid'

describe('grid math', () => {
  it('converts minutes <-> pixels (15 min = 24px)', () => {
    expect(minutesToPx(9 * 60, 8 * 60)).toBe(96)
    expect(minutesToPx(8 * 60 + 15, 8 * 60)).toBe(24)
    expect(pxToMinutes(96, 8 * 60)).toBe(9 * 60)
    expect(pxToMinutes(minutesToPx(637, 480), 480)).toBeCloseTo(637)
  })

  it('snaps to 15 minutes', () => {
    expect(snap(0)).toBe(0)
    expect(snap(7)).toBe(0)
    expect(snap(8)).toBe(15)
    expect(snap(22)).toBe(15)
    expect(snap(23)).toBe(30)
    expect(snap(547)).toBe(540)
  })

  it('slotFromPx snaps and stays inside the bounds', () => {
    const b = { startMin: 480, endMin: 1080 }
    expect(slotFromPx(0, b)).toBe(480)
    expect(slotFromPx(30, b)).toBe(495)
    expect(slotFromPx(-500, b)).toBe(480)
    expect(slotFromPx(99999, b, 60)).toBe(1020) // last start that still fits 60 min
  })

  it('bounds = min/max working hours widened to whole hours', () => {
    expect(gridBounds([{ start: 9 * 60, end: 18 * 60 }])).toEqual({ startMin: 540, endMin: 1080 })
    expect(gridBounds([{ start: 9 * 60 + 30, end: 17 * 60 + 15 }, { start: 8 * 60, end: 12 * 60 }])).toEqual({
      startMin: 480,
      endMin: 1080,
    })
  })

  it('falls back to 08:00-19:00 without hours', () => {
    expect(gridBounds([])).toEqual(FALLBACK_BOUNDS)
    expect(FALLBACK_BOUNDS).toEqual({ startMin: 480, endMin: 1140 })
  })

  it('grid height is 24px per 15 minutes', () => {
    expect(gridHeightPx({ startMin: 480, endMin: 1140 })).toBe(44 * 24)
  })

  it('non-working segments cover what the ranges leave out', () => {
    const b = { startMin: 480, endMin: 1140 }
    expect(nonWorkingSegments([{ start: 540, end: 720 }, { start: 840, end: 1080 }], b)).toEqual([
      { start: 480, end: 540 },
      { start: 720, end: 840 },
      { start: 1080, end: 1140 },
    ])
    expect(nonWorkingSegments([], b)).toEqual([{ start: 480, end: 1140 }])
  })
})
