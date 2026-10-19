// Package at payment: pure helpers shared by the Payment sheet, Financeiro and the tests.
// A package session costs R$ 0,00: the price of the appointment becomes 0 and one session is consumed.

export interface EligiblePackage {
  client_package_id: string
  template_name: string
  remaining: number
  expires_at: string
}

/** Result of rpc_apply_package_to_appointment (and the extra fields of rpc_complete_and_pay with a package). */
export interface PackageUse {
  client_package_id: string
  session_number: number
  sessions_total: number
  remaining: number
}

/** Message appended to HAS_PAYMENTS when the owner tried to use a package on a paid appointment. */
export const HAS_PAYMENTS_PACKAGE_HINT = 'Estorne o pagamento no Extrato antes de usar o pacote'

/** First chip of the Payment sheet: "PACOTE · 3 restantes". */
export function packageChipLabel(remaining: number): string {
  return `PACOTE · ${remaining} ${remaining === 1 ? 'restante' : 'restantes'}`
}

/** Gold pill of an A RECEBER row: "PACOTE · 3". */
export function packagePillLabel(remaining: number): string {
  return `PACOTE · ${remaining}`
}

/** Shown instead of the discount and payment lines once the package chip is selected. */
export function packageUseText(slot: { x: number; n: number } | null): string {
  return `Usa 1 sessão do pacote · R$ 0,00${slot ? ` · sessão ${slot.x}/${slot.n}` : ''}`
}

export function packageUsedMessage(r: Pick<PackageUse, 'session_number' | 'sessions_total'>): string {
  return `Sessão ${r.session_number}/${r.sessions_total} do pacote usada`
}

/**
 * The session this appointment would be: its position among the package's live appointments by start (the same
 * rule as the "Pacote · sessão X/N" pill), counting this one. Without a start, the next unused session.
 */
export function previewSession(total: number, remaining: number, linkedStarts: string[], startsAt: string | null | undefined): { x: number; n: number } | null {
  if (!(total > 0)) return null
  if (!startsAt) return { x: Math.min(total, total - remaining + 1), n: total }
  const mine = Date.parse(startsAt)
  if (Number.isNaN(mine)) return { x: Math.min(total, total - remaining + 1), n: total }
  const before = linkedStarts.filter((s) => Date.parse(s) < mine).length
  return { x: Math.min(total, before + 1), n: total }
}
