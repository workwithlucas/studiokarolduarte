// Same semantics as SQL normalize_phone(): digits only, strip leading zeros, prepend 55 when 10-11 digits,
// keep when it starts with 55 and has 12-13 digits, else null.
export function normalizePhone(p: unknown): string | null {
  if (typeof p !== 'string' && typeof p !== 'number') return null
  const d = String(p).replace(/\D/g, '').replace(/^0+/, '')
  if (d.length === 10 || d.length === 11) return `55${d}`
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) return d
  return null
}

export function firstName(name: string | null | undefined): string {
  const n = (name ?? '').trim().split(/\s+/)[0] ?? ''
  return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : ''
}

/**
 * Same semantics as SQL phone_key(): digits only, strip leading zeros, strip a leading 55 only when it is a
 * country code (12-13 digits), then DDD (first 2 digits) || last 8 digits. Ignores the optional 9th digit.
 * Shared vectors: tests/fixtures/phone-keys.json (checked against SQL by test:agent).
 */
export function phoneKey(p: unknown): string | null {
  if (typeof p !== 'string' && typeof p !== 'number') return null
  let d = String(p).replace(/\D/g, '').replace(/^0+/, '')
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2)
  if (d.length !== 10 && d.length !== 11) return null
  return d.slice(0, 2) + d.slice(-8)
}
