const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

/** Money is always integer cents. Non-integer or non-finite input renders as the fallback. */
export function formatBRL(cents: number | null | undefined, fallback = '—'): string {
  if (typeof cents !== 'number' || !Number.isInteger(cents)) return fallback
  return brl.format(cents / 100)
}
