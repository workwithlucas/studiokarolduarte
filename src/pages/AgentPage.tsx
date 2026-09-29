import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, EmptyState, FieldLabel, Input, Kicker, Pill, SectionHeader, Sheet, Skeleton, Textarea, Toggle, useSnackbar } from '../components/ui'
import { AppointmentSheet } from '../features/agenda/AppointmentSheet'
import { actionText, agentKey, MODE_LABEL, useAgentOverview, type AgentAction, type AgentMode, type AgentSettings, type AttentionItem } from '../lib/agentQueries'
import { formatDateTime } from '../lib/datetime'
import { formatPhoneBR, toTitlePt } from '../lib/format'
import { APPT_SELECT, type AppointmentRow } from '../lib/queries'
import { messageOf, rpc, supabase } from '../lib/rpc'

const MODES: AgentMode[] = ['off', 'test', 'live']
const card = 'rounded-[var(--radius-card)] border border-line bg-surface p-5 shadow-card'

export function AgentPage() {
  const q = useAgentOverview()
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [confirmLive, setConfirmLive] = useState(false)
  const [appt, setAppt] = useState<AppointmentRow | null>(null)
  const [messagesFor, setMessagesFor] = useState<AttentionItem | null>(null)

  const s = q.data?.settings
  const refresh = () => qc.invalidateQueries({ queryKey: agentKey })

  async function save(patch: Record<string, unknown>, ok?: string): Promise<boolean> {
    try {
      await rpc.agentSetSettings({ p_patch: patch as never })
      await refresh()
      if (ok) snack.show(ok, 'info')
      return true
    } catch (e) {
      snack.show(messageOf(e), 'error')
      return false
    }
  }

  async function run(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn()
      await refresh()
      snack.show(ok, 'info')
    } catch (e) {
      snack.show(messageOf(e), 'error')
    }
  }

  async function openAppointment(a: AgentAction) {
    if (a.entity !== 'appointments' || !a.entity_id) return
    const { data, error } = await supabase.from('appointments').select(APPT_SELECT).eq('id', a.entity_id).maybeSingle()
    if (error || !data) return snack.show('Não foi possível abrir este agendamento.', 'error')
    setAppt(data as unknown as AppointmentRow)
  }

  if (q.isLoading || !s) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-32" />
        <Skeleton className="h-48" />
      </div>
    )
  }
  if (q.isError) return <EmptyState title="Não foi possível carregar o agente" help={messageOf(q.error)} />

  const { attention, actions } = q.data!

  return (
    <div className="space-y-8">
      <header>
        <Kicker className="mb-1">Studio</Kicker>
        <h1 className="title-serif text-3xl">Agente</h1>
      </header>

      <section className={card}>
        <SectionHeader>Estado</SectionHeader>
        <div role="radiogroup" aria-label="Estado do agente" className="grid grid-cols-3 gap-1 rounded-full border border-line p-1">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={s.agent_mode === m}
              onClick={() => (m === 'live' && s.agent_mode !== 'live' ? setConfirmLive(true) : m !== s.agent_mode && void save({ agent_mode: m }, `Agente: ${MODE_LABEL[m]}`))}
              className={`label-caps hit rounded-full px-2 transition-colors duration-200 ${s.agent_mode === m ? 'bg-ink !text-surface' : ''}`}
            >
              {MODE_LABEL[m]}
            </button>
          ))}
        </div>
        <p className="text-help mt-3">
          {s.agent_mode === 'off' && 'A Thaís não responde ninguém.'}
          {s.agent_mode === 'test' && 'A Thaís responde só aos números de teste. As demais mensagens seguem para o sistema antigo.'}
          {s.agent_mode === 'live' && 'A Thaís responde todas as clientes.'}
        </p>
      </section>

      <TestNumbers key={s.agent_test_numbers.join(',')} numbers={s.agent_test_numbers} onSave={(n) => save({ agent_test_numbers: n }, 'Números de teste salvos')} />

      <WindowForm key={`${s.agent_window_start}|${s.agent_window_end}|${s.agent_away_message}`} s={s} onSave={(p) => save(p, 'Janela salva')} />

      <section className={card}>
        <SectionHeader>Confirmações</SectionHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium">Confirmar horários de amanhã</p>
            <p className="text-help">Envia uma mensagem por telefone, a partir do horário abaixo e até 20:00.</p>
          </div>
          <Toggle label="Confirmações automáticas" checked={s.confirmation_enabled} onChange={(v) => void save({ confirmation_enabled: v })} />
        </div>
        <div className="mt-4 max-w-40">
          <FieldLabel htmlFor="conf-hour">Enviar a partir de</FieldLabel>
          <Input id="conf-hour" type="time" step={900} defaultValue={s.confirmation_hour} onBlur={(e) => e.target.value && e.target.value !== s.confirmation_hour && void save({ confirmation_hour: e.target.value })} />
        </div>
      </section>

      <section>
        <SectionHeader>Precisa de você</SectionHeader>
        {attention.length === 0 ? (
          <EmptyState title="Nada pendente" help="Quando a Thaís precisar de você, a conversa aparece aqui." />
        ) : (
          <ul className="space-y-3">
            {attention.map((a) => (
              <li key={a.id} className={card}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="title-serif text-xl">{a.client_name ? toTitlePt(a.client_name) : formatPhoneBR(a.phone)}</h3>
                  {a.at && <Pill>{formatDateTime(a.at)}</Pill>}
                </div>
                <p className="mt-1 font-medium">{a.reason ?? 'Sem motivo informado'}</p>
                <p className="text-help mt-1 truncate">{a.last_inbound ?? 'Sem mensagem'}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <a href={`https://wa.me/${a.phone}`} target="_blank" rel="noopener noreferrer" className="hit inline-flex items-center justify-center rounded-full border border-line px-5 text-sm font-medium">
                    Abrir no WhatsApp
                  </a>
                  <Button variant="secondary" onClick={() => void run(() => rpc.agentReturnConversation({ p_conversation_id: a.id }), 'Conversa devolvida à Thaís')}>
                    Devolver à Thaís
                  </Button>
                  <Button variant="secondary" onClick={() => void run(() => rpc.agentDismissAttention({ p_conversation_id: a.id }), 'Marcada como resolvida')}>
                    Resolver
                  </Button>
                  <Button variant="ghost" onClick={() => setMessagesFor(a)}>
                    Ver últimas mensagens
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader>Atividade recente</SectionHeader>
        {actions.length === 0 ? (
          <EmptyState title="Sem atividade ainda" help="As ações da Thaís (agendar, remarcar, cancelar) aparecem aqui." />
        ) : (
          <ul className="space-y-2">
            {actions.map((a) => {
              const linked = a.entity === 'appointments' && !!a.entity_id
              const body = (
                <>
                  <span className="min-w-0">
                    <span className="block font-medium">{actionText(a.action)}{a.client_name ? ` · ${toTitlePt(a.client_name)}` : ''}</span>
                    <span className="text-help block">{formatDateTime(a.at)}{a.starts_at ? ` · horário ${formatDateTime(a.starts_at)}` : ''}</span>
                  </span>
                  {linked && <span className="label-caps">Abrir</span>}
                </>
              )
              return (
                <li key={a.id}>
                  {linked ? (
                    <button type="button" onClick={() => void openAppointment(a)} className="hit flex w-full items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-2 text-left">
                      {body}
                    </button>
                  ) : (
                    <div className="hit flex w-full items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-2">{body}</div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Sheet
        open={confirmLive}
        onClose={() => setConfirmLive(false)}
        title="Colocar a Thaís no ar?"
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setConfirmLive(false)}>
              Cancelar
            </Button>
            <Button
              block
              onClick={() => {
                setConfirmLive(false)
                void save({ agent_mode: 'live' }, 'Agente: No ar')
              }}
            >
              Colocar no ar
            </Button>
          </div>
        }
      >
        <p>A Thaís vai responder todas as clientes que escreverem no WhatsApp do studio, dentro da janela de atendimento.</p>
      </Sheet>

      <MessagesSheet item={messagesFor} onClose={() => setMessagesFor(null)} />
      <AppointmentSheet appointment={appt} onClose={() => setAppt(null)} />
    </div>
  )
}

function TestNumbers({ numbers, onSave }: { numbers: string[]; onSave: (n: string[]) => Promise<boolean> }) {
  const [value, setValue] = useState('')
  return (
    <section className={card}>
      <SectionHeader>Teste</SectionHeader>
      <p className="text-help mb-3">Números que a Thaís atende no modo Teste.</p>
      {numbers.length === 0 ? (
        <p className="text-help mb-3">Nenhum número cadastrado.</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {numbers.map((n) => (
            <li key={n} className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line px-4 py-2">
              <span>{formatPhoneBR(n)}</span>
              <Button variant="ghost" aria-label={`Remover ${formatPhoneBR(n)}`} onClick={() => void onSave(numbers.filter((x) => x !== n))}>
                Remover
              </Button>
            </li>
          ))}
        </ul>
      )}
      <FieldLabel htmlFor="test-number">Novo número (com DDD)</FieldLabel>
      <div className="flex gap-2">
        <Input id="test-number" inputMode="tel" placeholder="(11) 98765-4321" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button
          variant="secondary"
          disabled={!value.trim()}
          onClick={async () => {
            if (await onSave([...numbers, value.trim()])) setValue('')
          }}
        >
          Adicionar
        </Button>
      </div>
    </section>
  )
}

function WindowForm({ s, onSave }: { s: AgentSettings; onSave: (p: Record<string, unknown>) => Promise<boolean> }) {
  const [start, setStart] = useState(s.agent_window_start)
  const [end, setEnd] = useState(s.agent_window_end)
  const [away, setAway] = useState(s.agent_away_message)
  const dirty = start !== s.agent_window_start || end !== s.agent_window_end || away !== s.agent_away_message
  return (
    <section className={card}>
      <SectionHeader>Janela</SectionHeader>
      <p className="text-help mb-3">Fora deste horário a Thaís não responde: ela envia só a mensagem de ausência, uma vez a cada 12 horas.</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="win-start">Início</FieldLabel>
          <Input id="win-start" type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="win-end">Fim</FieldLabel>
          <Input id="win-end" type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div className="mt-3">
        <FieldLabel htmlFor="win-away">Mensagem de ausência</FieldLabel>
        <Textarea id="win-away" maxLength={500} value={away} onChange={(e) => setAway(e.target.value)} />
      </div>
      <div className="mt-4">
        <Button disabled={!dirty || !start || !end || !away.trim()} onClick={() => void onSave({ agent_window_start: start, agent_window_end: end, agent_away_message: away })}>
          Salvar janela
        </Button>
      </div>
    </section>
  )
}

function MessagesSheet({ item, onClose }: { item: AttentionItem | null; onClose: () => void }) {
  return (
    <Sheet open={!!item} onClose={onClose} kicker="Últimas mensagens" title={item ? (item.client_name ? toTitlePt(item.client_name) : formatPhoneBR(item.phone)) : ''}>
      {item && <MessagesBody id={item.id} />}
    </Sheet>
  )
}

function MessagesBody({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['agent', 'messages', id],
    queryFn: async () => (await rpc.agentRecentMessages({ p_conversation_id: id, p_limit: 6 })) as unknown as Array<{ direction: string; kind: string; body: string | null; created_at: string }>,
    staleTime: 0,
  })
  if (q.isLoading) return <Skeleton className="h-32" />
  if (q.isError) return <p role="alert" className="text-help !text-danger">{messageOf(q.error)}</p>
  const rows = [...(q.data ?? [])].reverse()
  if (rows.length === 0) return <p className="text-help">Sem mensagens.</p>
  return (
    <ul className="space-y-3">
      {rows.map((m, i) => (
        <li key={i}>
          <p className="text-help">
            {m.direction === 'in' ? 'Cliente' : 'Studio'} · {formatDateTime(m.created_at)}
          </p>
          <p className="whitespace-pre-line">{m.body ?? '[sem texto]'}</p>
        </li>
      ))}
    </ul>
  )
}
