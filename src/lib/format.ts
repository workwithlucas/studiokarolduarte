// Display helpers. Never used for stored data.

const LOWER = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'para', 'com', 'a', 'o', 'as', 'os'])

/** Title case for pt-BR names: small connectors stay lowercase except as the first word. */
export function toTitlePt(name: string | null | undefined): string {
  if (!name) return ''
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (i > 0 && LOWER.has(lower)) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join(' ')
}

/** '5511988880001' (E.164 digits) to '(11) 98888-0001'. Unknown shapes come back as typed. */
export function formatPhoneBR(phone: string | null | undefined, fallback = '—'): string {
  if (!phone) return fallback
  let d = phone.replace(/\D/g, '')
  if (d.startsWith('55') && (d.length === 12 || d.length === 13)) d = d.slice(2)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return phone
}

export type ActionKey = 'placement' | 'maintenance' | 'removal'

const ACTIONS: Record<ActionKey, string> = { placement: 'Colocação', maintenance: 'Manutenção', removal: 'Remoção' }
export function actionLabel(action: string | null | undefined): string {
  return (action && ACTIONS[action as ActionKey]) || '—'
}

const STATUSES: Record<string, string> = {
  scheduled: 'Agendado',
  confirmed: 'Confirmado',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  no_show: 'Faltou',
}
export function statusLabel(status: string | null | undefined): string {
  return (status && STATUSES[status]) || '—'
}

const CATEGORIES: Record<string, string> = {
  unhas: 'Unhas',
  cilios: 'Cílios',
  sobrancelhas: 'Sobrancelhas',
  outros: 'Outros',
}
export function categoryLabel(category: string | null | undefined): string {
  return (category && CATEGORIES[category]) || '—'
}

export function formatDuration(min: number | null | undefined): string {
  if (typeof min !== 'number' || !Number.isFinite(min)) return '—'
  const h = Math.floor(min / 60)
  const m = min % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

export function firstName(name: string | null | undefined): string {
  return toTitlePt(name).split(' ')[0] ?? ''
}

/** Hex colour guard for values coming from the database. */
export function safeColor(c: string | null | undefined, fallback = '#B57A88'): string {
  return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback
}
