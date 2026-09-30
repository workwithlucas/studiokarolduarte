const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/** Money is always integer cents. Non-integer or non-finite input renders as the fallback. */
export function formatBRL(cents: number | null | undefined, fallback = '—'): string {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return fallback
  return brl.format(cents / 100)
}

/**
 * Parses Brazilian money text to integer cents: 'R$ 1.234,56', '12,5', '12.50', '1.234' (dot + exactly 3 digits = thousands).
 * Null for blank, negative or non-numeric input.
 */
export function parseBRL(input: string | null | undefined): number | null {
  let s = (input ?? '').replace(/R\$/gi, '').replace(/\s/g, '')
  if (!s) return null
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  return Math.round(Number(s) * 100)
}

/** Cents as plain number text for CSV exports: 123450 → '1234,50'. */
export function centsToPlain(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`
}
