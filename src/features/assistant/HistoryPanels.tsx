// HISTÓRICO (archived conversations, read-only) and AÇÕES (permanent log of what the assistant executed).
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button, EmptyState, Pill, Skeleton } from '../../components/ui'
import {
  ACTIONS_PAGE, getThread, invalidateAfterWrite, listActions, listThreads, undoLogged,
  type ActionLogItem, type PendingView, type ThreadSummary,
} from '../../lib/assistantQueries'
import { LOG_STATUS, actionsToCsv, groupActionsByDay, undoVisible } from '../../lib/assistantHistory'
import { formatDateTime, formatTime } from '../../lib/datetime'
import { formatBRL } from '../../lib/money'
import { MessageList } from './MessageList'

const LOAD_ERROR = 'Não consegui carregar. Confira a conexão e tente de novo.'

export function HistoryPanel() {
  const [open, setOpen] = useState<ThreadSummary | null>(null)
  const threads = useQuery({ queryKey: ['assistant-threads'], queryFn: listThreads, staleTime: 0 })
  const thread = useQuery({ queryKey: ['assistant-archived-thread', open?.thread_id], queryFn: () => getThread(open!.thread_id), enabled: !!open })
  const pendings = useMemo(() => Object.fromEntries((thread.data?.pendings ?? []).map((p) => [p.id, p])) as Record<string, PendingView>, [thread.data])

  if (open) {
    return (
      <div className="space-y-3">
        <Button variant="secondary" icon={<ArrowLeft size={18} />} onClick={() => setOpen(null)}>
          Voltar
        </Button>
        <div>
          <p className="title-serif text-lg break-words">{open.title}</p>
          <p className="text-help">{formatDateTime(open.started_at)} · {open.message_count} mensagens · arquivada</p>
        </div>
        {thread.isLoading && <Skeleton className="h-24" />}
        {thread.isError && <p className="text-help" role="alert">{LOAD_ERROR}</p>}
        {thread.data && <MessageList messages={thread.data.messages} pendings={pendings} readOnly />}
      </div>
    )
  }
  if (threads.isLoading) return <Skeleton className="h-24" />
  if (threads.isError) return <p className="text-help" role="alert">{LOAD_ERROR}</p>
  if (!threads.data?.length) return <EmptyState title="Nenhuma conversa arquivada." />
  return (
    <ul className="space-y-2">
      {threads.data.map((t) => (
        <li key={t.thread_id}>
          <button
            type="button"
            onClick={() => setOpen(t)}
            className="hit w-full rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3 text-left transition-colors duration-200 hover:border-border-gold"
          >
            <span className="block break-words text-sm">{t.title}</span>
            <span className="text-help">{formatDateTime(t.started_at)} · {t.message_count} mensagens</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function download(name: string, csv: string) {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export function ActionsPanel({ onUndone }: { onUndone: (pendingId: string, index: number) => void }) {
  const qc = useQueryClient()
  const q = useInfiniteQuery({
    queryKey: ['assistant-actions'],
    queryFn: ({ pageParam }) => listActions(pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.has_more ? pages.length * ACTIONS_PAGE : undefined),
    staleTime: 0,
  })
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})
  const items = useMemo(() => q.data?.pages.flatMap((p) => p.actions) ?? [], [q.data])
  const groups = useMemo(() => groupActionsByDay(items), [items])
  const keyOf = (a: ActionLogItem) => `${a.pending_id}:${a.action_index}`

  async function undo(a: ActionLogItem) {
    const key = keyOf(a)
    setBusyKey(key)
    try {
      const r = await undoLogged(a.pending_id, a.action_index)
      setMessages((m) => ({ ...m, [key]: r.message }))
      if (r.ok) {
        onUndone(a.pending_id, a.action_index)
        invalidateAfterWrite(qc)
        await q.refetch()
      }
    } catch (e) {
      setMessages((m) => ({ ...m, [key]: e instanceof Error ? e.message : LOAD_ERROR }))
    } finally {
      setBusyKey(null)
    }
  }

  if (q.isLoading) return <Skeleton className="h-24" />
  if (q.isError) return <p className="text-help" role="alert">{LOAD_ERROR}</p>
  if (!items.length) return <EmptyState title="Nenhuma ação executada." />
  return (
    <div className="space-y-4">
      <Button variant="secondary" onClick={() => download('acoes-assistente.csv', actionsToCsv(items))}>
        Exportar CSV
      </Button>
      {groups.map((g) => (
        <section key={g.day || 'x'} className="space-y-2">
          <p className="label-caps">{g.label}</p>
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line bg-surface">
            {g.items.map((a) => {
              const key = keyOf(a)
              const st = LOG_STATUS[a.status]
              return (
                <li key={key} className="space-y-2 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-help">{formatTime(a.executed_at)}</p>
                      <p className="break-words text-sm">{a.summary}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {a.amount_cents !== null && <p className="text-sm">{formatBRL(a.amount_cents)}</p>}
                      <Pill tone={st.tone}>{st.label}</Pill>
                    </div>
                  </div>
                  {undoVisible(a) && (
                    <Button variant="secondary" onClick={() => void undo(a)} disabled={busyKey !== null} loading={busyKey === key}>
                      Desfazer
                    </Button>
                  )}
                  {messages[key] && <p className="text-help" role="status">{messages[key]}</p>}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      {q.hasNextPage && (
        <Button variant="secondary" block onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
          Carregar mais
        </Button>
      )}
    </div>
  )
}
