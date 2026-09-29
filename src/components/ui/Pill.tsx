import type { ReactNode } from 'react'
import { safeColor } from '../../lib/format'

export type PillTone = 'neutral' | 'success' | 'warn' | 'danger' | 'gold' | 'primary'

const TONES: Record<PillTone, string> = {
  neutral: 'bg-line text-muted',
  success: 'bg-success/15 !text-success',
  warn: 'bg-warn/15 !text-warn',
  danger: 'bg-danger/15 !text-danger',
  gold: 'bg-gold/30 !text-ink',
  primary: 'bg-primary-from/15 !text-primary-to',
}

/** `color` paints the pill with a professional's colour instead of a tone. */
export function Pill({ children, tone = 'neutral', color }: { children: ReactNode; tone?: PillTone; color?: string | null }) {
  const c = color ? safeColor(color) : null
  return (
    <span
      className={`label-caps inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 ${c ? '' : TONES[tone]}`}
      style={c ? { backgroundColor: `${c}26`, color: c } : undefined}
    >
      {children}
    </span>
  )
}
