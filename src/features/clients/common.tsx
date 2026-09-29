import { MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Pill, type PillTone } from '../../components/ui'
import { formatDate } from '../../lib/datetime'
import { toTitlePt } from '../../lib/format'

const SEGMENTS: Record<string, { label: string; tone: PillTone }> = {
  nova: { label: 'Nova', tone: 'gold' },
  ativa: { label: 'Ativa', tone: 'success' },
  inativa: { label: 'Inativa', tone: 'neutral' },
}

export function SegmentPill({ segment }: { segment: string | null | undefined }) {
  const s = SEGMENTS[segment ?? ''] ?? SEGMENTS.nova
  return <Pill tone={s.tone}>{s.label}</Pill>
}

export function initials(name: string | null | undefined): string {
  const parts = toTitlePt(name).split(' ').filter(Boolean)
  if (parts.length === 0) return '?'
  const first = parts[0]!.charAt(0)
  const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : ''
  return (first + last).toUpperCase()
}

export function Avatar({ name }: { name: string | null | undefined }) {
  return (
    <span
      aria-hidden="true"
      className="title-serif inline-flex size-11 shrink-0 items-center justify-center rounded-full text-base !text-surface [background:var(--primary-gradient)]"
    >
      {initials(name)}
    </span>
  )
}

/** 'dd/MM' from a date or timestamp; fallback when missing. */
export function dayMonth(input: unknown, fallback = '—'): string {
  const full = formatDate(input, '')
  return full ? full.slice(0, 5) : fallback
}

export function WhatsAppButton({ phone }: { phone: string | null | undefined }) {
  const digits = (phone ?? '').replace(/\D/g, '')
  return (
    <Button
      variant="secondary"
      icon={<MessageCircle size={16} />}
      disabled={!digits}
      onClick={() => window.open(`https://wa.me/${digits}`, '_blank', 'noopener,noreferrer')}
    >
      WhatsApp
    </Button>
  )
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}
