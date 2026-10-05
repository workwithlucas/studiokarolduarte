// Thaís' tools. All run with service_role. Every argument is validated and every id is checked in code
// against this conversation's known client set: ownership is never delegated to the prompt.
import type { ToolDef } from './anthropic.ts'
import { callRpc, RpcFailure, unwrap, updateConversation } from './db.ts'
import { argEnum, argText, argUuid, argUuidList, checkPendingGate, isKnownClient, PENDING_TTL_MS, type ArgResult } from './gates.ts'
import { normalizePhone } from './phone.ts'
import { sha256Hex } from './security.ts'
import { hhmm, humanSlot, isoOf, parseInstant, spParts, validYmd, addDays, weekdayName, ddmm } from './time.ts'
import type { Conversation, Deps, PendingAction, Settings } from './types.ts'

export interface ToolCtx {
  deps: Deps
  conv: Conversation
  settings: Settings
  /** created_at of the newest inbound message in the snapshot the run started from (database clock). */
  snapshotLastInboundAt: string | null
  flags: { handoff: boolean; noted: boolean; booked: boolean }
}

type Out = Record<string, unknown>
const fail = (error: string, message: string): Out => ({ ok: false, error, message })
const invalid = (r: ArgResult<unknown> & { ok: false }): Out => fail('INVALID_ARGUMENT', r.message)

export function formatBRL(cents: number): string {
  const v = (cents / 100).toFixed(2).replace('.', ',')
  return `R$ ${v.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`
}

const ACTIONS = ['placement', 'maintenance', 'removal'] as const
const CATEGORIES = ['unhas', 'cilios', 'sobrancelhas', 'outros'] as const

// ---------------------------------------------------------------- definitions
const uuid = { type: 'string', description: 'uuid devolvido por uma ferramenta' }
export const TOOL_DEFS: ToolDef[] = [
  { name: 'lookup_client', description: 'Busca cadastros pelo telefone desta conversa. Chame primeiro. Se houver exatamente um, ele é selecionado e o contexto vem junto.', input_schema: { type: 'object', properties: {} } },
  { name: 'choose_client', description: 'Escolhe, entre os cadastros do telefone, para quem é o atendimento (número compartilhado).', input_schema: { type: 'object', properties: { client_id: uuid }, required: ['client_id'] } },
  { name: 'find_client_by_name', description: 'Use só quando lookup_client não achou ninguém pelo telefone e a cliente já disse nome e sobrenome. Procura pelo nome; vincula este telefone a um cadastro sem telefone, cria o cadastro se não existir, ou encaminha para a equipe quando houver dúvida.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'nome e sobrenome da cliente' } }, required: ['name'] } },
  { name: 'register_client', description: 'Cadastra uma cliente nova com o telefone desta conversa. Use quando lookup_client não achar ninguém ou for outra pessoa do mesmo número.', input_schema: { type: 'object', properties: { name: { type: 'string', description: 'nome da cliente' } }, required: ['name'] } },
  { name: 'list_services', description: 'Serviços ativos com ações (colocação, manutenção, remoção), durações, preços e adicionais.', input_schema: { type: 'object', properties: { category: { type: 'string', enum: [...CATEGORIES] } } } },
  { name: 'suggest_professionals', description: 'Profissionais que fazem o serviço, com a habitual da cliente primeiro.', input_schema: { type: 'object', properties: { service_id: uuid }, required: ['service_id'] } },
  {
    name: 'get_availability',
    description: 'Horários livres (no máximo 3 dias e 6 horários por dia), em horário de São Paulo.',
    input_schema: {
      type: 'object',
      properties: {
        professional_id: uuid, service_id: uuid, action: { type: 'string', enum: [...ACTIONS] },
        addon_ids: { type: 'array', items: uuid }, from_date: { type: 'string', description: 'YYYY-MM-DD' }, to_date: { type: 'string', description: 'YYYY-MM-DD' },
      },
      required: ['professional_id', 'service_id', 'action', 'from_date', 'to_date'],
    },
  },
  {
    name: 'propose_booking',
    description: 'Propõe um agendamento (não grava ainda). O horário precisa estar na lista de get_availability. Devolve o resumo para apresentar à cliente.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: uuid, professional_id: uuid, service_id: uuid, action: { type: 'string', enum: [...ACTIONS] },
        addon_ids: { type: 'array', items: uuid }, starts_at: { type: 'string', description: 'starts_at exatamente como devolvido por get_availability' },
        use_package: { type: 'boolean', description: 'true quando active_packages da cliente cobre este serviço: usa uma sessão do pacote' },
      },
      required: ['client_id', 'professional_id', 'service_id', 'action', 'starts_at'],
    },
  },
  { name: 'propose_reschedule', description: 'Propõe remarcar um agendamento da cliente (não grava ainda).', input_schema: { type: 'object', properties: { appointment_id: uuid, new_starts_at: { type: 'string' }, professional_id: uuid }, required: ['appointment_id', 'new_starts_at'] } },
  { name: 'propose_cancel', description: 'Propõe cancelar um agendamento da cliente (não grava ainda).', input_schema: { type: 'object', properties: { appointment_id: uuid }, required: ['appointment_id'] } },
  { name: 'confirm_pending', description: 'Executa a proposta pendente. Só funciona depois que o resumo foi enviado E a cliente respondeu aceitando.', input_schema: { type: 'object', properties: {} } },
  { name: 'discard_pending', description: 'Descarta a proposta pendente (a cliente desistiu ou mudou).', input_schema: { type: 'object', properties: {} } },
  { name: 'list_my_appointments', description: 'Próximos agendamentos das clientes conhecidas desta conversa.', input_schema: { type: 'object', properties: {} } },
  { name: 'confirm_attendance', description: 'Confirma a presença da cliente em um horário que aguarda confirmação.', input_schema: { type: 'object', properties: { appointment_id: uuid }, required: ['appointment_id'] } },
  { name: 'note_for_karol', description: 'Deixa um recado para a Karol (dúvida sem resposta, referência enviada, etc.). A conversa continua com você.', input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'handoff_to_human', description: 'Passa a conversa para a equipe (saúde, reclamação, pagamento, desconto, negociação).', input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
]

// ---------------------------------------------------------------- helpers
async function setClient(ctx: ToolCtx, clientId: string, alsoKnown: string[] = []): Promise<void> {
  const known = [...new Set([...ctx.conv.known_client_ids, clientId, ...alsoKnown])]
  await updateConversation(ctx.deps.db, ctx.conv.id, { client_id: clientId, known_client_ids: known })
  ctx.conv.client_id = clientId
  ctx.conv.known_client_ids = known
}

interface ClientRow { id: string; name: string; archived?: boolean }

async function candidates(ctx: ToolCtx): Promise<ClientRow[]> {
  const rows = await callRpc<Array<Record<string, any>>>(ctx.deps.db, 'rpc_find_client_by_phone', { p_phone: ctx.conv.phone_e164 })
  return (rows ?? []).filter((r) => !r.archived).map((r) => ({ id: r.id as string, name: r.name as string }))
}

/** Client context WITHOUT money: explicit whitelist, so a new money field can never leak through. */
export async function safeClientContext(ctx: Pick<ToolCtx, 'deps'>, clientId: string): Promise<Out | null> {
  try {
    const c = await callRpc<Record<string, any>>(ctx.deps.db, 'rpc_get_client_context', { p_client_id: clientId })
    const pros = unwrap<Array<{ id: string; name: string }>>(await ctx.deps.db.from('professionals').select('id,name'))
    const nameOf = (id: unknown) => pros.find((p) => p.id === id)?.name ?? null
    return {
      client_id: c.client_id,
      name: c.name,
      segment: c.segment,
      visit_count: c.visit_count,
      last_visit_at: c.last_visit_at,
      needs_return: c.needs_return,
      habitual_professional: c.preferred_professional_id ? { id: c.preferred_professional_id, name: nameOf(c.preferred_professional_id) } : null,
      active_packages: c.active_packages ?? [],
      last_completed: ((c.last_completed as Array<Record<string, any>>) ?? []).map((a) => ({
        when: humanSlot(parseInstant(a.starts_at) ?? 0), service: a.service_name, professional: nameOf(a.professional_id),
      })),
      next_appointments: ((c.next_appointments as Array<Record<string, any>>) ?? []).map((a) => ({
        id: a.id, when: humanSlot(parseInstant(a.starts_at) ?? 0), service: a.service_name, professional: nameOf(a.professional_id), status: a.status,
      })),
    }
  } catch (e) {
    if (e instanceof RpcFailure) return null
    throw e
  }
}

interface SlotQuery { professionalId: string; serviceId: string; action: string; addonIds: string[] }

async function fetchSlots(ctx: ToolCtx, q: SlotQuery, from: string, to: string): Promise<Array<{ starts_at: string; ms: number }>> {
  const rows = await callRpc<Array<{ starts_at: string }>>(ctx.deps.db, 'rpc_get_availability', {
    p_professional_id: q.professionalId, p_service_id: q.serviceId, p_action: q.action, p_addon_ids: q.addonIds,
    p_from: from, p_to: to, p_source: 'agent',
  })
  return (rows ?? []).flatMap((r) => {
    const ms = parseInstant(r.starts_at)
    return ms === null ? [] : [{ starts_at: isoOf(ms), ms }]
  })
}

/** "The slot must be in the availability list": re-queried from the database, never trusted from the model. */
async function slotOffered(ctx: ToolCtx, q: SlotQuery, startsMs: number): Promise<boolean> {
  const day = spParts(startsMs).ymd
  return (await fetchSlots(ctx, q, day, day)).some((s) => s.ms === startsMs)
}

function pickSpread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]!)
}

interface ApptRow {
  id: string; client_id: string; professional_id: string; service_id: string; action: string; status: string; starts_at: string
  service?: { name: string } | null; professional?: { name: string } | null
}

async function ownedAppointment(ctx: ToolCtx, idArg: unknown): Promise<{ ok: true; appt: ApptRow } | { ok: false; out: Out }> {
  const id = argUuid(idArg, 'appointment_id')
  if (!id.ok) return { ok: false, out: invalid(id) }
  const appt = unwrap<ApptRow | null>(
    await ctx.deps.db.from('appointments').select('id,client_id,professional_id,service_id,action,status,starts_at,service:services(name),professional:professionals(name)').eq('id', id.value).maybeSingle(),
  )
  // Same answer whether it does not exist or belongs to someone else: nothing leaks.
  if (!appt || !isKnownClient(ctx.conv, appt.client_id)) return { ok: false, out: fail('NOT_FOUND', 'Agendamento não encontrado para esta cliente.') }
  const ms = parseInstant(appt.starts_at)
  if (!['scheduled', 'confirmed'].includes(appt.status) || ms === null || ms <= ctx.deps.now()) {
    return { ok: false, out: fail('NOT_ALLOWED', 'Este agendamento não pode ser alterado (já passou ou não está ativo).') }
  }
  return { ok: true, appt }
}

async function addonIdsOf(ctx: ToolCtx, appointmentId: string): Promise<string[]> {
  const rows = unwrap<Array<{ addon_id: string }>>(await ctx.deps.db.from('appointment_addons').select('addon_id').eq('appointment_id', appointmentId))
  return (rows ?? []).map((r) => r.addon_id)
}

async function writePending(ctx: ToolCtx, type: PendingAction['type'], params: Record<string, unknown>, summary: Record<string, unknown>): Promise<PendingAction> {
  const now = ctx.deps.now()
  const pending: PendingAction = { type, params, summary, proposed_at: isoOf(now), expires_at: isoOf(now + PENDING_TTL_MS), presented_baseline: null }
  await updateConversation(ctx.deps.db, ctx.conv.id, { pending_action: pending })
  ctx.conv.pending_action = pending
  return pending
}

async function clearPending(ctx: ToolCtx): Promise<void> {
  await updateConversation(ctx.deps.db, ctx.conv.id, { pending_action: null })
  ctx.conv.pending_action = null
}

const pending_msg = 'Proposta registrada. Apresente o resumo à cliente e aguarde a resposta dela; só então chame confirm_pending.'

// ---------------------------------------------------------------- dispatcher
export async function executeTool(ctx: ToolCtx, name: string, input: unknown): Promise<Out> {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  try {
    switch (name) {
      case 'lookup_client': return await lookupClient(ctx)
      case 'choose_client': return await chooseClient(ctx, args)
      case 'register_client': return await registerClient(ctx, args)
      case 'find_client_by_name': return await findClientByName(ctx, args)
      case 'list_services': return await listServices(ctx, args)
      case 'suggest_professionals': return await suggestProfessionals(ctx, args)
      case 'get_availability': return await getAvailability(ctx, args)
      case 'propose_booking': return await proposeBooking(ctx, args)
      case 'propose_reschedule': return await proposeReschedule(ctx, args)
      case 'propose_cancel': return await proposeCancel(ctx, args)
      case 'confirm_pending': return await confirmPending(ctx)
      case 'discard_pending':
        await clearPending(ctx)
        return { ok: true }
      case 'list_my_appointments': return await listMyAppointments(ctx)
      case 'confirm_attendance': return await confirmAttendance(ctx, args)
      case 'note_for_karol': return await noteForKarol(ctx, args)
      case 'handoff_to_human': return await handoff(ctx, args)
      default: return fail('UNKNOWN_TOOL', `Ferramenta desconhecida: ${name}`)
    }
  } catch (e) {
    if (e instanceof RpcFailure) return fail(e.code, e.detail ?? e.code)
    throw e
  }
}

// ---------------------------------------------------------------- clients
async function lookupClient(ctx: ToolCtx): Promise<Out> {
  const cands = await candidates(ctx)
  if (cands.length === 1) {
    const only = cands[0]!
    await setClient(ctx, only.id)
    return { ok: true, candidates: cands, current_client_id: only.id, context: await safeClientContext(ctx, only.id), note: 'Cliente identificada pelo telefone: nunca pergunte o nome. Cite agendamentos só se o pedido dela for sobre eles.' }
  }
  return { ok: true, candidates: cands, current_client_id: ctx.conv.client_id, note: cands.length ? 'Mais de um cadastro neste telefone: pergunte para quem é e use choose_client.' : 'Nenhum cadastro com este telefone: pergunte nome e sobrenome (uma única vez) e use find_client_by_name.' }
}

async function chooseClient(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const id = argUuid(a.client_id, 'client_id')
  if (!id.ok) return invalid(id)
  const cands = await candidates(ctx)
  if (!cands.some((c) => c.id === id.value) && !isKnownClient(ctx.conv, id.value)) {
    return fail('NOT_A_CANDIDATE', 'Este cadastro não pertence a este telefone.')
  }
  await setClient(ctx, id.value)
  return { ok: true, current_client_id: id.value, context: await safeClientContext(ctx, id.value) }
}

async function registerClient(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const name = argText(a.name, 'name', 2, 80)
  if (!name.ok) return invalid(name)
  if (!/^[\p{L}][\p{L} '.-]*$/u.test(name.value)) return fail('INVALID_ARGUMENT', 'name inválido')
  if (!normalizePhone(ctx.conv.phone_e164)) return fail('INVALID_PHONE', 'Telefone inválido.')
  const id = await callRpc<string>(ctx.deps.db, 'rpc_upsert_client', {
    p_name: name.value, p_phone: ctx.conv.phone_e164, p_external_code: null, p_birthday: null, p_notes: null,
  })
  await setClient(ctx, id)
  return { ok: true, client_id: id, name: name.value }
}

/** Identity by name: first + last name, accent/case-insensitive. The rules live in rpc_find_client_by_name. */
async function findClientByName(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const name = argText(a.name, 'name', 3, 80)
  if (!name.ok) return invalid(name)
  if (!/^[\p{L}][\p{L} '.-]*$/u.test(name.value)) return fail('INVALID_ARGUMENT', 'name inválido')
  const res = await callRpc<{ result: string; client_id?: string; name?: string }>(ctx.deps.db, 'rpc_find_client_by_name', { p_name: name.value, p_phone: ctx.conv.phone_e164 })
  if (res.result === 'need_full_name') return fail('NEED_FULL_NAME', 'Peça o nome e o sobrenome da cliente.')
  if (res.result === 'handoff_multiple' || res.result === 'handoff_other_phone') {
    const reason = res.result === 'handoff_multiple' ? 'Mais de um cadastro com este nome: confirmar quem é a cliente' : 'Já existe uma cliente com este nome e outro telefone: confirmar antes de vincular'
    await callRpc(ctx.deps.db, 'agent_flag', { p_conversation_id: ctx.conv.id, p_reason: reason, p_handoff: true, p_handoff_hours: 12 })
    ctx.conv.mode = 'human'
    ctx.conv.needs_attention = true
    ctx.flags.handoff = true
    return { ok: true, result: 'handoff', next: 'Avise em uma frase curta que a Karol vai falar com ela.' }
  }
  if (!res.client_id) return fail('NOT_FOUND', 'Cadastro não encontrado.')
  await setClient(ctx, res.client_id)
  return { ok: true, result: res.result, client_id: res.client_id, context: await safeClientContext(ctx, res.client_id) }
}

// ---------------------------------------------------------------- catalog
async function listServices(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  let category: string | null = null
  if (a.category !== undefined && a.category !== null) {
    const c = argEnum(a.category, CATEGORIES, 'category')
    if (!c.ok) return invalid(c)
    category = c.value
  }
  const db = ctx.deps.db
  const svcs = unwrap<Array<Record<string, any>>>(
    await db.from('services').select('id,name,category,kind,duration_min,price_cents,maintenance_duration_min,maintenance_price_cents,cash_price_cents').eq('active', true).order('name'),
  )
  const addons = unwrap<Array<Record<string, any>>>(await db.from('service_addons').select('id,service_id,name,price_delta_cents,duration_delta_min').eq('active', true))
  return {
    ok: true,
    services: (svcs ?? []).filter((s) => !category || s.category === category).map((s) => {
      const actions =
        s.kind === 'removal'
          ? [{ action: 'removal', duration_min: s.duration_min, price_cents: s.price_cents, price: formatBRL(s.price_cents) }]
          : [
              { action: 'placement', duration_min: s.duration_min, price_cents: s.price_cents, price: formatBRL(s.price_cents) },
              ...(s.maintenance_price_cents != null
                ? [{ action: 'maintenance', duration_min: s.maintenance_duration_min ?? s.duration_min, price_cents: s.maintenance_price_cents, price: formatBRL(s.maintenance_price_cents) }]
                : []),
            ]
      return {
        id: s.id, name: s.name, category: s.category, actions,
        cash_price: s.cash_price_cents != null ? formatBRL(s.cash_price_cents) : null,
        addons: (addons ?? []).filter((x) => x.service_id === s.id).map((x) => ({
          id: x.id, name: x.name, price_delta: formatBRL(x.price_delta_cents), price_delta_cents: x.price_delta_cents, duration_delta_min: x.duration_delta_min,
        })),
      }
    }),
  }
}

async function suggestProfessionals(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const sid = argUuid(a.service_id, 'service_id')
  if (!sid.ok) return invalid(sid)
  const rows = await callRpc<Array<Record<string, any>>>(ctx.deps.db, 'rpc_suggest_professionals', { p_client_id: ctx.conv.client_id, p_service_id: sid.value })
  return {
    ok: true,
    professionals: (rows ?? []).map((r, i) => ({ id: r.professional_id, name: r.name, visits_with_client: r.visits, habitual: i === 0 && r.visits > 0 })),
  }
}

// ---------------------------------------------------------------- availability
async function getAvailability(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const pro = argUuid(a.professional_id, 'professional_id')
  const svc = argUuid(a.service_id, 'service_id')
  const act = argEnum(a.action, ACTIONS, 'action')
  const addons = argUuidList(a.addon_ids, 'addon_ids')
  for (const r of [pro, svc, act, addons]) if (!r.ok) return invalid(r)
  const today = spParts(ctx.deps.now()).ymd
  let from = validYmd(a.from_date)
  let to = validYmd(a.to_date)
  if (!from || !to) return fail('INVALID_ARGUMENT', 'from_date e to_date devem ser YYYY-MM-DD')
  if (from < today) from = today
  if (to < from) return fail('INVALID_ARGUMENT', 'to_date deve ser depois de from_date')
  if (to > addDays(from, 21)) to = addDays(from, 21)
  const slots = await fetchSlots(ctx, { professionalId: (pro as any).value, serviceId: (svc as any).value, action: (act as any).value, addonIds: (addons as any).value }, from, to)
  const byDay = new Map<string, typeof slots>()
  for (const s of slots) {
    const d = spParts(s.ms).ymd
    byDay.set(d, [...(byDay.get(d) ?? []), s])
  }
  const days = [...byDay.entries()].slice(0, 3).map(([date, list]) => ({
    date, weekday: weekdayName(spParts(list[0]!.ms).weekday), label: ddmm(date),
    slots: pickSpread(list, 6).map((s) => ({ starts_at: s.starts_at, time: hhmm(s.ms) })),
  }))
  return { ok: true, days, note: days.length ? undefined : 'Sem horários livres neste período. Tente outras datas.' }
}

// ---------------------------------------------------------------- proposals
async function proposeBooking(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const client = argUuid(a.client_id, 'client_id')
  const pro = argUuid(a.professional_id, 'professional_id')
  const svc = argUuid(a.service_id, 'service_id')
  const act = argEnum(a.action, ACTIONS, 'action')
  const addons = argUuidList(a.addon_ids, 'addon_ids')
  for (const r of [client, pro, svc, act, addons]) if (!r.ok) return invalid(r)
  if (a.use_package !== undefined && a.use_package !== null && typeof a.use_package !== 'boolean') return fail('INVALID_ARGUMENT', 'use_package deve ser verdadeiro ou falso')
  const clientId = (client as any).value as string
  if (!isKnownClient(ctx.conv, clientId)) return fail('NOT_ALLOWED', 'Esta cliente não pertence a esta conversa. Use lookup_client / choose_client.')
  const startsMs = parseInstant(a.starts_at)
  if (startsMs === null || startsMs <= ctx.deps.now()) return fail('INVALID_ARGUMENT', 'starts_at inválido')
  const q: SlotQuery = { professionalId: (pro as any).value, serviceId: (svc as any).value, action: (act as any).value, addonIds: (addons as any).value }
  if (!(await slotOffered(ctx, q, startsMs))) return fail('SLOT_NOT_OFFERED', 'Este horário não está na lista de disponibilidade. Use get_availability e escolha um horário da lista.')

  const db = ctx.deps.db
  const s = unwrap<Record<string, any> | null>(await db.from('services').select('id,name,kind,duration_min,price_cents,maintenance_duration_min,maintenance_price_cents,active').eq('id', q.serviceId).maybeSingle())
  const p = unwrap<Record<string, any> | null>(await db.from('professionals').select('id,name').eq('id', q.professionalId).maybeSingle())
  if (!s || !s.active || !p) return fail('NOT_FOUND', 'Serviço ou profissional não encontrado.')
  const ads = unwrap<Array<Record<string, any>>>(await db.from('service_addons').select('id,name,price_delta_cents,duration_delta_min').eq('service_id', q.serviceId).eq('active', true).in('id', q.addonIds.length ? q.addonIds : ['00000000-0000-0000-0000-000000000000']))
  if ((ads ?? []).length !== q.addonIds.length) return fail('NOT_FOUND', 'Adicional não encontrado para este serviço.')
  const base = q.action === 'maintenance' ? s.maintenance_price_cents : s.price_cents
  if (base == null) return fail('ACTION_INVALID', 'Ação inválida para este serviço.')
  const price = base + ads.reduce((n, x) => n + x.price_delta_cents, 0)
  const dur = (q.action === 'maintenance' ? (s.maintenance_duration_min ?? s.duration_min) : s.duration_min) + ads.reduce((n, x) => n + x.duration_delta_min, 0)

  // Package session: the client's packages are re-read from the database, never taken from the model.
  let pkg: { id: string; remaining: number } | null = null
  if (a.use_package === true) {
    const found = await findPackage(ctx, clientId, q.serviceId, spParts(startsMs).ymd)
    if (!found.ok) return found.out
    pkg = found.pkg
  }
  const summary: Record<string, unknown> = {
    servico: s.name, acao: q.action, adicionais: ads.map((x) => x.name), dia_e_hora: humanSlot(startsMs), profissional: p.name,
    duracao_min: dur,
    ...(pkg ? { pacote: `vai usar uma sessão do seu pacote (restam ${pkg.remaining - 1})` } : { valor: formatBRL(price) }),
  }
  await writePending(ctx, 'book', {
    client_id: clientId, professional_id: q.professionalId, service_id: q.serviceId, action: q.action, addon_ids: q.addonIds, starts_at: isoOf(startsMs),
    ...(pkg ? { client_package_id: pkg.id } : {}),
  }, summary)
  return { ok: true, summary, next: pending_msg }
}

/** An active package of this (known) client that covers the service on the booking day, with sessions left. */
async function findPackage(ctx: ToolCtx, clientId: string, serviceId: string, ymd: string): Promise<{ ok: true; pkg: { id: string; remaining: number } } | { ok: false; out: Out }> {
  const c = await callRpc<Record<string, any>>(ctx.deps.db, 'rpc_get_client_context', { p_client_id: clientId })
  const covering = ((c.active_packages as Array<Record<string, any>>) ?? []).filter((p) => p.service_id === serviceId)
  if (!covering.length) return { ok: false, out: fail('PACKAGE_INVALID', 'A cliente não tem pacote ativo para este serviço.') }
  const withSessions = covering.filter((p) => p.remaining > 0)
  if (!withSessions.length) return { ok: false, out: fail('PACKAGE_EMPTY', 'O pacote não tem mais sessões.') }
  const valid = withSessions.find((p) => String(p.expires_at).slice(0, 10) >= ymd)
  if (!valid) return { ok: false, out: fail('PACKAGE_EXPIRED', 'O pacote vence antes da data escolhida.') }
  return { ok: true, pkg: { id: valid.client_package_id as string, remaining: valid.remaining as number } }
}

async function proposeReschedule(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const owned = await ownedAppointment(ctx, a.appointment_id)
  if (!owned.ok) return owned.out
  const { appt } = owned
  const newMs = parseInstant(a.new_starts_at)
  if (newMs === null || newMs <= ctx.deps.now()) return fail('INVALID_ARGUMENT', 'new_starts_at inválido')
  let proId = appt.professional_id
  if (a.professional_id !== undefined && a.professional_id !== null) {
    const p = argUuid(a.professional_id, 'professional_id')
    if (!p.ok) return invalid(p)
    proId = p.value
  }
  const q: SlotQuery = { professionalId: proId, serviceId: appt.service_id, action: appt.action, addonIds: await addonIdsOf(ctx, appt.id) }
  if (!(await slotOffered(ctx, q, newMs))) return fail('SLOT_NOT_OFFERED', 'Este horário não está na lista de disponibilidade. Use get_availability e escolha um horário da lista.')
  const p = unwrap<Record<string, any> | null>(await ctx.deps.db.from('professionals').select('name').eq('id', proId).maybeSingle())
  const summary = {
    servico: appt.service?.name ?? null, de: humanSlot(parseInstant(appt.starts_at) ?? 0), para: humanSlot(newMs), profissional: p?.name ?? null,
  }
  await writePending(ctx, 'reschedule', { appointment_id: appt.id, new_starts_at: isoOf(newMs), professional_id: proId }, summary)
  return { ok: true, summary, next: pending_msg }
}

async function proposeCancel(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const owned = await ownedAppointment(ctx, a.appointment_id)
  if (!owned.ok) return owned.out
  const { appt } = owned
  const summary = { servico: appt.service?.name ?? null, dia_e_hora: humanSlot(parseInstant(appt.starts_at) ?? 0), profissional: appt.professional?.name ?? null }
  await writePending(ctx, 'cancel', { appointment_id: appt.id }, summary)
  return { ok: true, summary, next: pending_msg }
}

async function confirmPending(ctx: ToolCtx): Promise<Out> {
  const pending = ctx.conv.pending_action
  const gate = checkPendingGate(pending, ctx.deps.now(), ctx.snapshotLastInboundAt)
  if (!gate.ok) {
    if (gate.error === 'EXPIRED') await clearPending(ctx)
    return fail(gate.error, gate.message)
  }
  const p = pending as PendingAction
  const db = ctx.deps.db
  try {
    if (p.type === 'book') {
      const prm = p.params as Record<string, any>
      if (!isKnownClient(ctx.conv, prm.client_id)) return fail('NOT_ALLOWED', 'Cliente fora desta conversa.')
      const key = await sha256Hex(ctx.conv.id + JSON.stringify(p.params) + p.proposed_at)
      const id = await callRpc<string>(db, 'rpc_book_appointment', {
        p_client_id: prm.client_id, p_professional_id: prm.professional_id, p_service_id: prm.service_id, p_action: prm.action,
        p_addon_ids: prm.addon_ids, p_starts_at: prm.starts_at, p_source: 'agent', p_idempotency_key: key, p_notes: null,
        p_client_package_id: prm.client_package_id ?? null,
      })
      ctx.flags.booked = true
      await clearPending(ctx)
      return { ok: true, type: 'book', appointment_id: id, summary: p.summary }
    }
    const owned = await ownedAppointment(ctx, (p.params as Record<string, unknown>).appointment_id)
    if (!owned.ok) {
      await clearPending(ctx)
      return owned.out
    }
    if (p.type === 'reschedule') {
      await callRpc(db, 'rpc_reschedule_appointment', {
        p_appointment_id: owned.appt.id, p_new_starts_at: p.params.new_starts_at, p_new_professional_id: p.params.professional_id ?? null,
      })
    } else {
      await callRpc(db, 'rpc_cancel_appointment', { p_appointment_id: owned.appt.id, p_reason: 'Cliente cancelou pelo WhatsApp' })
    }
    await clearPending(ctx)
    return { ok: true, type: p.type, appointment_id: owned.appt.id, summary: p.summary }
  } catch (e) {
    if (e instanceof RpcFailure) {
      await clearPending(ctx) // the proposal is stale after any rule violation: propose again
      if (e.code === 'PACKAGE_EMPTY' || e.code === 'PACKAGE_EXPIRED' || e.code === 'PACKAGE_INVALID') {
        return {
          ...fail(e.code, e.detail ?? e.code),
          next: 'O pacote não pode ser usado. Diga à cliente que o pacote não tem sessões disponíveis, proponha o agendamento pago (propose_booking sem use_package) e chame note_for_karol.',
        }
      }
      return fail(e.code, e.detail ?? e.code)
    }
    throw e
  }
}

// ---------------------------------------------------------------- appointments of the known clients
async function listMyAppointments(ctx: ToolCtx): Promise<Out> {
  if (!ctx.conv.known_client_ids.length) return { ok: true, appointments: [] }
  const rows = unwrap<Array<Record<string, any>>>(
    await ctx.deps.db.from('appointments')
      .select('id,client_id,starts_at,status,action,service:services(name),professional:professionals(name),client:clients(name)')
      .in('client_id', ctx.conv.known_client_ids).in('status', ['scheduled', 'confirmed'])
      .gte('starts_at', isoOf(ctx.deps.now())).order('starts_at').limit(10),
  )
  return {
    ok: true,
    appointments: (rows ?? []).map((r) => ({
      id: r.id, client: r.client?.name ?? null, service: r.service?.name ?? null, professional: r.professional?.name ?? null,
      when: humanSlot(parseInstant(r.starts_at) ?? 0), status: r.status,
    })),
  }
}

async function confirmAttendance(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const id = argUuid(a.appointment_id, 'appointment_id')
  if (!id.ok) return invalid(id)
  const db = ctx.deps.db
  const conf = unwrap<{ appointment_id: string } | null>(await db.from('wa_confirmations').select('appointment_id').eq('appointment_id', id.value).maybeSingle())
  const appt = unwrap<{ id: string; client_id: string; status: string } | null>(await db.from('appointments').select('id,client_id,status').eq('id', id.value).maybeSingle())
  if (!conf || !appt || !isKnownClient(ctx.conv, appt.client_id)) return fail('NOT_ALLOWED', 'Este horário não está aguardando confirmação nesta conversa.')
  if (appt.status === 'confirmed') return { ok: true, already: true }
  if (appt.status !== 'scheduled') return fail('BAD_TRANSITION', 'Este horário não pode mais ser confirmado.')
  await callRpc(db, 'rpc_confirm_appointment', { p_appointment_id: appt.id })
  return { ok: true }
}

// ---------------------------------------------------------------- escalation
async function noteForKarol(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const t = argText(a.text, 'text', 3, 300)
  if (!t.ok) return invalid(t)
  await callRpc(ctx.deps.db, 'agent_flag', { p_conversation_id: ctx.conv.id, p_reason: t.value, p_handoff: false })
  ctx.conv.needs_attention = true
  ctx.flags.noted = true
  return { ok: true }
}

async function handoff(ctx: ToolCtx, a: Record<string, unknown>): Promise<Out> {
  const t = argText(a.reason, 'reason', 3, 300)
  if (!t.ok) return invalid(t)
  await callRpc(ctx.deps.db, 'agent_flag', { p_conversation_id: ctx.conv.id, p_reason: t.value, p_handoff: true, p_handoff_hours: 12 })
  ctx.conv.mode = 'human'
  ctx.conv.needs_attention = true
  ctx.flags.handoff = true
  return { ok: true, next: 'Avise em uma frase curta que a Karol vai falar com ela.' }
}
