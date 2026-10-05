// Builds the model request pieces: chat history (merged turns) and the dynamic system block.
import type { ChatMessage } from './anthropic.ts'
import { unwrap, type StoredMessage } from './db.ts'
import { safeClientContext, type ToolCtx } from './tools.ts'
import { addDays, ddmm, humanSlot, parseInstant, spParts, weekdayName, weekdayOfYmd } from './time.ts'

/** Label for what staff typed on the phone: the model must never repeat or contradict it. */
export const STAFF_LABEL = '[Equipe]'

/** Consecutive same-role messages become one turn; the first turn is always a user turn. Staff messages are labeled. */

export function buildMessages(history: StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of history) {
    const role: 'user' | 'assistant' = m.direction === 'in' ? 'user' : 'assistant'
    const raw = (m.body ?? '').trim() || (role === 'user' ? (m.kind === 'audio' ? '[mensagem de voz sem transcrição]' : '[mensagem sem texto]') : '')
    if (!raw) continue
    const text = m.sender === 'staff' || (m.direction === 'out' && m.from_human) ? `${STAFF_LABEL} ${raw}` : raw
    const last = out[out.length - 1]
    if (last && last.role === role) last.content = `${last.content as string}\n${text}`
    else out.push({ role, content: text })
  }
  while (out.length && out[0]!.role === 'assistant') out.shift()
  return out
}

/** Professionals, working hours and services come from the database; nothing about them is written in the prompt. */
async function catalogLines(deps: ToolCtx['deps']): Promise<string[]> {
  const pros = unwrap<Array<{ id: string; name: string }>>(await deps.db.from('professionals').select('id,name').eq('active', true).order('name'))
  const hours = unwrap<Array<{ professional_id: string; weekday: number; start_time: string; end_time: string }>>(
    await deps.db.from('working_hours').select('professional_id,weekday,start_time,end_time').order('weekday').order('start_time'),
  )
  const svcs = unwrap<Array<{ name: string; duration_min: number }>>(await deps.db.from('services').select('name,duration_min').eq('active', true).order('name'))
  const t = (v: string) => v.slice(0, 5)
  const proLine = (p: { id: string; name: string }) => {
    const hs = (hours ?? []).filter((h) => h.professional_id === p.id)
    return `${p.name} — ${hs.length ? hs.map((h) => `${weekdayName(h.weekday)} ${t(h.start_time)}-${t(h.end_time)}`).join(', ') : 'sem horário cadastrado'}`
  }
  return [
    'PROFISSIONAIS E HORÁRIOS DE TRABALHO (cadastro): ' + ((pros ?? []).length ? (pros ?? []).map(proLine).join('; ') : 'nenhuma.'),
    'SERVIÇOS ATIVOS (nome, duração; preços só por list_services): ' + ((svcs ?? []).length ? (svcs ?? []).map((s) => `${s.name} (${s.duration_min} min)`).join('; ') : 'nenhum.'),
  ]
}

export async function buildDynamicBlock(ctx: ToolCtx): Promise<string> {
  const { deps, conv, settings } = ctx
  const now = deps.now()
  const p = spParts(now)
  const lines: string[] = []
  lines.push(`AGORA: ${weekdayName(p.weekday)}, ${ddmm(p.ymd)}/${p.ymd.slice(0, 4)}, ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')} (America/Sao_Paulo).`)
  lines.push('PRÓXIMOS DIAS: ' + Array.from({ length: 10 }, (_, i) => {
    const d = addDays(p.ymd, i)
    return `${weekdayName(weekdayOfYmd(d))} ${ddmm(d)} = ${d}`
  }).join('; ') + '.')
  lines.push(`HORÁRIO DE ATENDIMENTO PELO WHATSAPP: ${settings.agent_window_start} às ${settings.agent_window_end}.`)
  lines.push(...(await catalogLines(deps)))

  const known = conv.known_client_ids.length
    ? unwrap<Array<{ id: string; name: string }>>(await deps.db.from('clients').select('id,name').in('id', conv.known_client_ids))
    : []
  lines.push(
    'CLIENTES CONHECIDAS NESTA CONVERSA: ' +
      (known.length ? known.map((k) => `${k.name} (id ${k.id})${k.id === conv.client_id ? ' [atual]' : ''}`).join('; ') : 'nenhuma ainda (chame lookup_client).'),
  )

  const pa = conv.pending_action
  lines.push(
    'PROPOSTA PENDENTE: ' +
      (pa
        ? `${pa.type} — ${JSON.stringify(pa.summary)} — ${pa.presented_baseline ? 'resumo já apresentado à cliente; aguardando a resposta dela' : 'ainda NÃO apresentada à cliente'}; expira em ${pa.expires_at}.`
        : 'nenhuma.'),
  )

  if (conv.known_client_ids.length) {
    const rows = unwrap<Array<Record<string, any>>>(
      await deps.db.from('appointments')
        .select('id,starts_at,status,service:services(name),professional:professionals(name),client:clients(name),wa_confirmations!inner(appointment_id)')
        .in('client_id', conv.known_client_ids).eq('status', 'scheduled').gte('starts_at', new Date(now).toISOString()).order('starts_at').limit(8),
    )
    lines.push(
      'AGUARDANDO CONFIRMAÇÃO: ' +
        ((rows ?? []).length
          ? rows.map((r) => `${r.client?.name ?? ''} — ${r.service?.name ?? ''} com ${r.professional?.name ?? ''}, ${humanSlot(parseInstant(r.starts_at) ?? 0)} (id ${r.id})`).join('; ')
          : 'nada.'),
    )
  }

  if (conv.client_id) {
    const c = await safeClientContext(ctx, conv.client_id)
    if (c) lines.push(`CONTEXTO DA CLIENTE ATUAL (identificada pelo telefone; nunca pergunte o nome dela): ${JSON.stringify(c)}`)
  }
  lines.push('Agendamentos e histórico da cliente são só para consulta: cite um agendamento apenas se o pedido da cliente for sobre ele.')
  lines.push('Mensagens marcadas com [Equipe] foram escritas pela equipe no celular do studio.')
  if (conv.audio_failures >= 1) {
    lines.push('AVISO: a última mensagem de voz não pôde ser entendida. Peça de forma simpática que a cliente repita, sem citar áudio nem limitações.')
  }
  return lines.join('\n')
}
