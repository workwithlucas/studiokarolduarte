// Owner-only finance chat. Loaded lazily (AssistantLauncher), so the rest of the app does not grow.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Send } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Button, Chip, ChipRow, EmptyState, Input, Sheet, Skeleton, TabLabel, TabList } from '../../components/ui'
import {
  invalidateAfterWrite, invokeAssistant, loadThread, mergeMessages, mergePendings,
  type AssistantBody, type MessageView, type PendingView,
} from '../../lib/assistantQueries'
import { Bubble, Typing } from './cards'
import { ActionsPanel, HistoryPanel } from './HistoryPanels'
import { MessageList } from './MessageList'

type Tab = 'chat' | 'history' | 'actions'

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
  const [tab, setTab] = useState<Tab>('chat')
  const [askNew, setAskNew] = useState(false)
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

  // The current conversation goes to the Histórico; what is on screen starts empty.
  async function startNew() {
    setBusy(true)
    setFailure(null)
    try {
      await invokeAssistant({ action: 'new_thread' })
      setMessages([])
      setPendings({})
      setLoaded(true)
      setAskNew(false)
      void qc.invalidateQueries({ queryKey: ['assistant-threads'] })
    } catch (e) {
      setFailure({ message: e instanceof Error ? e.message : 'Algo deu errado. Tente novamente.', retry: () => void startNew() })
    } finally {
      setBusy(false)
    }
  }

  // An undo done from the log: the card of the conversation must not offer it again.
  const onLogUndone = (pendingId: string, index: number) =>
    setPendings((p) => (p[pendingId] ? { ...p, [pendingId]: { ...p[pendingId]!, undoable: p[pendingId]!.undoable.filter((i) => i !== index) } } : p))

  return (
    <Sheet
      open={open}
      onClose={onClose}
      kicker="Financeiro"
      title="Assistente"
      footer={
        tab !== 'chat' ? undefined : (
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
        )
      }
    >
      <div className="mb-4 space-y-3">
        <TabList>
          <TabLabel active={tab === 'chat'} onClick={() => setTab('chat')}>Conversa</TabLabel>
          <TabLabel active={tab === 'history'} onClick={() => setTab('history')}>Histórico</TabLabel>
          <TabLabel active={tab === 'actions'} onClick={() => setTab('actions')}>Ações</TabLabel>
        </TabList>
        {tab === 'chat' && !askNew && (
          <Button variant="secondary" icon={<Plus size={18} />} onClick={() => setAskNew(true)} disabled={busy || messages.length === 0}>
            Nova conversa
          </Button>
        )}
        {tab === 'chat' && askNew && (
          <div role="alertdialog" aria-label="Nova conversa" className="space-y-3 rounded-[var(--radius-input)] border border-border-gold bg-surface-2 p-4">
            <p className="text-sm">A conversa atual vai para o Histórico.</p>
            <div className="flex gap-2">
              <Button block onClick={() => void startNew()} disabled={busy}>
                Confirmar
              </Button>
              <Button block variant="secondary" onClick={() => setAskNew(false)} disabled={busy}>
                Voltar
              </Button>
            </div>
          </div>
        )}
      </div>
      {tab === 'history' && <HistoryPanel />}
      {tab === 'actions' && <ActionsPanel onUndone={onLogUndone} />}
      {tab === 'chat' && (
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
        <MessageList
          messages={messages}
          pendings={pendings}
          busy={busy}
          handlers={{
            onConfirm: (id) => void run({ action: 'confirm', pending_id: id, request_id: crypto.randomUUID() }),
            onCancel: (id) => void run({ action: 'cancel', pending_id: id, request_id: crypto.randomUUID() }),
            onUndo: (id, index) => void run({ action: 'undo', pending_id: id, action_index: index, request_id: crypto.randomUUID() }),
            onPick: (choiceId, value, label) => void run({ action: 'message', text: label, pick: { choice_id: choiceId, value }, request_id: crypto.randomUUID() }, label),
            onAnswer: send,
          }}
        />
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
      )}
    </Sheet>
  )
}
