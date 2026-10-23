// Cards of the finance assistant. Every text in them was built by the function from database values.
import { Check, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Pill } from '../../components/ui'
import { parseDateTime } from '../../lib/datetime'
import type { Card, PendingView } from '../../lib/assistantQueries'

type Of<K extends Card['kind']> = Extract<Card, { kind: K }>

export function Bubble({ role, children }: { role: 'user' | 'assistant'; children: ReactNode }) {
  const mine = role === 'user'
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <p
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-[var(--radius-input)] px-4 py-3 text-sm leading-relaxed ${
          mine ? 'bg-primary-bg text-primary-ink' : 'border border-line bg-surface-2 text-ink'
        }`}
      >
        {children}
      </p>
    </div>
  )
}

export function Typing() {
  return (
    <div role="status" aria-label="O assistente está escrevendo" className="flex justify-start">
      <div className="flex gap-1.5 rounded-[var(--radius-input)] border border-line bg-surface-2 px-4 py-4">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-2 animate-pulse rounded-full bg-muted" style={{ animationDelay: `${i * 160}ms` }} />
        ))}
      </div>
    </div>
  )
}

function Frame({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-[var(--radius-card)] border border-border-gold bg-surface p-4 shadow-[var(--shadow-card)]">
      {title && <p className="title-serif text-lg">{title}</p>}
      {children}
    </div>
  )
}

function Lines({ lines }: { lines: Array<{ label: string; value: string }> }) {
  return (
    <dl className="space-y-1.5">
      {lines.map((l, i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 text-sm">
          <dt className="label-caps shrink-0">{l.label}</dt>
          <dd className="min-w-0 break-words text-right">{l.value}</dd>
        </div>
      ))}
    </dl>
  )
}

const STATUS: Record<PendingView['status'], { label: string; tone: 'success' | 'neutral' | 'warn' | 'danger' }> = {
  pending: { label: 'Aguardando', tone: 'neutral' },
  confirmed: { label: 'Confirmado', tone: 'success' },
  cancelled: { label: 'Cancelado', tone: 'neutral' },
  expired: { label: 'Expirou', tone: 'warn' },
  failed: { label: 'Não concluído', tone: 'danger' },
}

/** Minutes left until `expiresAt` (validated parse), refreshed every 20 seconds. Null when the date is unreadable. */
function useMinutesLeft(expiresAt: string, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(t)
  }, [active])
  const exp = parseDateTime(expiresAt)
  return exp ? Math.ceil((exp.getTime() - now) / 60_000) : null
}

export function ProposalCard({
  card, pending, busy, onConfirm, onCancel,
}: {
  card: Of<'proposal'>
  pending: PendingView | undefined
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const status = pending?.status ?? 'pending'
  const open = status === 'pending'
  const left = useMinutesLeft(card.expires_at, open)
  const timedOut = open && left !== null && left <= 0
  return (
    <Frame>
      {card.actions.map((a, i) => (
        <section key={i} className={`space-y-2 ${i > 0 ? 'border-t border-line pt-3' : ''}`}>
          <p className="title-serif text-lg">{a.title}</p>
          <Lines lines={a.lines} />
          {a.warnings.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {a.warnings.map((w) => (
                <Pill key={w} tone="warn">
                  {w}
                </Pill>
              ))}
            </div>
          )}
        </section>
      ))}
      {open ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button block onClick={onConfirm} disabled={busy || timedOut} loading={busy}>
              Confirmar
            </Button>
            <Button block variant="secondary" onClick={onCancel} disabled={busy}>
              Cancelar
            </Button>
          </div>
          <p className="text-help">{timedOut ? 'Essa proposta expirou.' : left !== null ? `Vale por mais ${left} min.` : null}</p>
        </div>
      ) : (
        <Pill tone={STATUS[status].tone}>{STATUS[status].label}</Pill>
      )}
    </Frame>
  )
}

export function ResultCard({
  card, pending, busy, onUndo,
}: {
  card: Of<'result'>
  pending: PendingView | undefined
  busy: boolean
  onUndo: (index: number) => void
}) {
  return (
    <Frame>
      <ul className="space-y-2">
        {card.lines.map((l) => (
          <li key={l.index} className="flex items-start gap-3 text-sm">
            <span aria-hidden className={`mt-0.5 shrink-0 ${l.ok ? 'text-success' : 'text-danger'}`}>
              {l.ok ? <Check size={18} /> : <X size={18} />}
            </span>
            <span className="sr-only">{l.ok ? 'Feito:' : 'Não feito:'}</span>
            <span className="min-w-0 flex-1 break-words">{l.text}</span>
            {l.ok && pending?.undoable.includes(l.index) && (
              <Button variant="secondary" onClick={() => onUndo(l.index)} disabled={busy}>
                Desfazer
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Frame>
  )
}

/** Candidates built by code. Active only while it is the last thing in the thread. */
export function ChoiceChips({
  card, disabled, onPick,
}: {
  card: Of<'choice'>
  disabled: boolean
  onPick: (value: string, label: string) => void
}) {
  return (
    <Frame title={card.question}>
      <div className="flex flex-col gap-2">
        {card.options.map((o) => (
          <button
            key={o.value}
            type="button"
            disabled={disabled}
            onClick={() => onPick(o.value, o.label)}
            className="hit w-full rounded-[var(--radius-input)] border border-line bg-surface px-4 py-2 text-left transition-colors duration-200 enabled:hover:border-border-gold disabled:opacity-40"
          >
            <span className="block text-sm">{o.label}</span>
            <span className="text-help">{o.detail}</span>
          </button>
        ))}
      </div>
    </Frame>
  )
}

export function QuestionChips({ card, disabled, onAnswer }: { card: Of<'question'>; disabled: boolean; onAnswer: (label: string) => void }) {
  return (
    <Frame title={card.question}>
      {card.options.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {card.options.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(o.label)}
              className="label-caps hit inline-flex items-center rounded-full border border-line bg-surface px-4 transition-colors duration-200 enabled:hover:border-border-gold disabled:opacity-40"
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </Frame>
  )
}

export function EntriesCard({ card }: { card: Of<'entries'> }) {
  return (
    <Frame title={card.title}>
      {card.rows.length === 0 ? (
        <p className="text-help">Nenhum lançamento encontrado.</p>
      ) : (
        <ul className="divide-y divide-line">
          {card.rows.map((r, i) => (
            <li key={i} className="flex items-start justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="break-words">{r.title}</p>
                <p className="text-help">
                  {r.detail} · {r.status}
                </p>
              </div>
              <p className="shrink-0">{r.value}</p>
            </li>
          ))}
        </ul>
      )}
      {card.total > card.rows.length && <p className="text-help">Mostrando {card.rows.length} de {card.total}. Peça um filtro para ver o resto.</p>}
    </Frame>
  )
}

export function FactsCard({ card }: { card: Of<'facts'> }) {
  return (
    <Frame title={card.title}>
      <Lines lines={card.lines} />
    </Frame>
  )
}
