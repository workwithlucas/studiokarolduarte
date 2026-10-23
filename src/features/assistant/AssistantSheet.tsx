// Owner-only finance chat. Loaded lazily (AssistantLauncher), so the rest of the app does not grow.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Chip, ChipRow, EmptyState, Input, Sheet, Skeleton } from '../../components/ui'
import {
  invalidateAfterWrite, invokeAssistant, loadThread, mergeMessages, mergePendings,
  type AssistantBody, type MessageView, type PendingView,
} from '../../lib/assistantQueries'
import { Bubble, ChoiceChips, EntriesCard, FactsCard, ProposalCard, QuestionChips, ResultCard, Typing } from './cards'

const STARTERS = [
  { label: 'Lançar despesa', text: 'Lançar despesa' },
  { label: 'Dar baixa', text: 'Quero dar baixa em um lançamento' },
  { label: 'Resumo de hoje', text: 'Resumo de hoje' },
]

interface Failure {
  message: string
  retry: () => void
}

export default function AssistantSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const thread = useQuery({ queryKey: ['assistant-thread'], queryFn: loadThread, enabled: open, staleTime: Infinity, gcTime: 0 })
  const [messages, setMessages] = useState<MessageView[]>([])
  const [pendings, setPendings] = useState<Record<string, PendingView>>({})
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!thread.data || loaded) return
    setMessages((m) => mergeMessages(thread.data!.messages, m))
    setPendings((p) => mergePendings(thread.data!.pendings.reduce((acc, x) => ({ ...acc, [x.id]: x }), {} as Record<string, PendingView>), Object.values(p)))
    setLoaded(true)
  }, [thread.data, loaded])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, busy, failure, open])

  // One crypto.randomUUID per send; a retry re-sends the very same body, so the function replays instead of repeating.
  const run = useCallback(
    async (body: AssistantBody, shown?: string) => {
      setBusy(true)
      setFailure(null)
      setOptimistic(shown ?? null)
      try {
        const res = await invokeAssistant(body)
        setMessages((m) => mergeMessages(m, res.messages))
        setPendings((p) => mergePendings(p, res.pendings))
        if (body.action === 'confirm' || body.action === 'undo') invalidateAfterWrite(qc)
      } catch (e) {
        setFailure({ message: e instanceof Error ? e.message : 'Algo deu errado. Tente novamente.', retry: () => void run(body, shown) })
      } finally {
        setBusy(false)
        setOptimistic(null)
      }
    },
    [qc],
  )

  const send = (text: string) => {
    const t = text.trim()
    if (!t || busy) return
    setDraft('')
    void run({ action: 'message', text: t, request_id: crypto.randomUUID() }, t)
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    send(draft)
  }

  const empty = loaded && messages.length === 0 && !optimistic
  const lastId = messages[messages.length - 1]?.id

  return (
    <Sheet
      open={open}
      onClose={onClose}
      kicker="Financeiro"
      title="Assistente"
      footer={
        <form onSubmit={onSubmit} className="flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Escreva aqui"
            aria-label="Mensagem para o assistente"
            maxLength={1000}
            enterKeyHint="send"
            disabled={busy}
          />
          <Button type="submit" aria-label="Enviar" disabled={busy || !draft.trim()} icon={<Send size={18} />} />
        </form>
      }
    >
      <div className="space-y-3" aria-live="polite">
        {thread.isLoading && !loaded && <Skeleton className="h-24" />}
        {thread.isError && !loaded && <p className="text-help">Não consegui carregar a conversa anterior. Você ainda pode escrever.</p>}
        {empty && (
          <EmptyState
            title="Como posso ajudar?"
            help="Lanço despesas, dou baixa em pagamentos, uso pacotes e mostro resumos. Você sempre confirma antes de eu fazer."
            action={
              <ChipRow>
                {STARTERS.map((s) => (
                  <Chip key={s.label} onClick={() => send(s.text)} disabled={busy}>
                    {s.label}
                  </Chip>
                ))}
              </ChipRow>
            }
          />
        )}
        {messages.map((m) => {
          if (m.role !== 'card') return m.body ? <Bubble key={m.id} role={m.role}>{m.body}</Bubble> : null
          const c = m.card
          if (!c) return null
          const active = m.id === lastId && !busy
          switch (c.kind) {
            case 'proposal':
              return (
                <ProposalCard
                  key={m.id}
                  card={c}
                  pending={pendings[c.pending_id]}
                  busy={busy}
                  onConfirm={() => void run({ action: 'confirm', pending_id: c.pending_id, request_id: crypto.randomUUID() })}
                  onCancel={() => void run({ action: 'cancel', pending_id: c.pending_id, request_id: crypto.randomUUID() })}
                />
              )
            case 'result':
              return (
                <ResultCard
                  key={m.id}
                  card={c}
                  pending={pendings[c.pending_id]}
                  busy={busy}
                  onUndo={(index) => void run({ action: 'undo', pending_id: c.pending_id, action_index: index, request_id: crypto.randomUUID() })}
                />
              )
            case 'choice':
              return (
                <ChoiceChips
                  key={m.id}
                  card={c}
                  disabled={!active}
                  onPick={(value, label) => void run({ action: 'message', text: label, pick: { choice_id: c.choice_id, value }, request_id: crypto.randomUUID() }, label)}
                />
              )
            case 'question':
              return <QuestionChips key={m.id} card={c} disabled={!active} onAnswer={send} />
            case 'entries':
              return <EntriesCard key={m.id} card={c} />
            case 'facts':
              return <FactsCard key={m.id} card={c} />
            default:
              return null
          }
        })}
        {optimistic && <Bubble role="user">{optimistic}</Bubble>}
        {busy && <Typing />}
        {failure && (
          <div role="alert" className="space-y-2 rounded-[var(--radius-input)] border border-danger/40 bg-danger/10 p-4">
            <p className="text-sm">{failure.message}</p>
            <Button variant="secondary" onClick={failure.retry} disabled={busy}>
              Tentar de novo
            </Button>
          </div>
        )}
        <div ref={end} />
      </div>
    </Sheet>
  )
}
