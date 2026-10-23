import { describe, expect, it } from 'vitest'
import { cancelable, claimable, lostClaim } from '../../supabase/functions/_shared/assistant-state.ts'

const NOW = Date.parse('2026-10-23T15:00:00Z')
const row = (status: string, expires = '2026-10-23T15:10:00Z') => ({ status: status as never, expires_at: expires })

describe('pending state machine', () => {
  it('confirm claims only a pending, unexpired row', () => {
    expect(claimable(row('pending'), NOW)).toBe(true)
    expect(claimable(row('pending', '2026-10-23T14:59:59Z'), NOW)).toBe(false) // expired
    expect(claimable(row('pending', '2026-10-23T15:00:00Z'), NOW)).toBe(false) // expires_at > now is strict
    for (const s of ['confirmed', 'cancelled', 'expired', 'failed']) expect(claimable(row(s), NOW)).toBe(false)
    expect(claimable(row('pending', 'garbage'), NOW)).toBe(false)
  })
  it('double confirm: after the first claim the row is confirmed, so the second is a replay', () => {
    expect(claimable(row('confirmed'), NOW)).toBe(false)
    expect(lostClaim(row('confirmed'))).toBe('replay')
    expect(lostClaim(row('failed'))).toBe('replay')
  })
  it('expiry: a pending row that lost the claim is discarded', () => {
    expect(lostClaim(row('pending', '2026-10-23T14:00:00Z'))).toBe('expire_now')
    expect(lostClaim(row('expired'))).toBe('expired')
  })
  it('cancel works only while pending', () => {
    expect(cancelable(row('pending'))).toBe(true)
    for (const s of ['confirmed', 'cancelled', 'expired', 'failed']) expect(cancelable(row(s))).toBe(false)
    expect(lostClaim(row('cancelled'))).toBe('cancelled')
  })
  it('unknown row', () => {
    expect(lostClaim(null)).toBe('missing')
  })
})
