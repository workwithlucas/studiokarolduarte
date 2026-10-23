// The messages of a thread. The live conversation passes handlers; an archived thread passes readOnly and nothing can be pressed.
import type { MessageView, PendingView } from '../../lib/assistantQueries'
import { Bubble, ChoiceChips, EntriesCard, FactsCard, ProposalCard, QuestionChips, ResultCard } from './cards'

export interface MessageHandlers {
  onConfirm: (pendingId: string) => void
  onCancel: (pendingId: string) => void
  onUndo: (pendingId: string, index: number) => void
  onPick: (choiceId: string, value: string, label: string) => void
  onAnswer: (label: string) => void
}

const NONE: MessageHandlers = { onConfirm: () => {}, onCancel: () => {}, onUndo: () => {}, onPick: () => {}, onAnswer: () => {} }

export function MessageList({
  messages, pendings, busy = false, readOnly = false, handlers = NONE,
}: {
  messages: MessageView[]
  pendings: Record<string, PendingView>
  busy?: boolean
  readOnly?: boolean
  handlers?: MessageHandlers
}) {
  const lastId = messages[messages.length - 1]?.id
  return (
    <>
      {messages.map((m) => {
        if (m.role !== 'card') return m.body ? <Bubble key={m.id} role={m.role}>{m.body}</Bubble> : null
        const c = m.card
        if (!c) return null
        const active = !readOnly && m.id === lastId && !busy
        switch (c.kind) {
          case 'proposal':
            return (
              <ProposalCard
                key={m.id}
                card={c}
                pending={pendings[c.pending_id]}
                busy={busy}
                readOnly={readOnly}
                onConfirm={() => handlers.onConfirm(c.pending_id)}
                onCancel={() => handlers.onCancel(c.pending_id)}
              />
            )
          case 'result':
            return (
              <ResultCard
                key={m.id}
                card={c}
                pending={pendings[c.pending_id]}
                busy={busy}
                readOnly={readOnly}
                onUndo={(index) => handlers.onUndo(c.pending_id, index)}
              />
            )
          case 'choice':
            return <ChoiceChips key={m.id} card={c} disabled={!active} onPick={(value, label) => handlers.onPick(c.choice_id, value, label)} />
          case 'question':
            return <QuestionChips key={m.id} card={c} disabled={!active} onAnswer={handlers.onAnswer} />
          case 'entries':
            return <EntriesCard key={m.id} card={c} />
          case 'facts':
            return <FactsCard key={m.id} card={c} />
          default:
            return null
        }
      })}
    </>
  )
}
