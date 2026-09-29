import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Chip,
  ChipRow,
  EmptyState,
  FieldLabel,
  Input,
  Kicker,
  SectionHeader,
  Sheet,
  Skeleton,
  TabLabel,
  TabList,
  Toggle,
  useSnackbar,
} from '../../components/ui'
import { addDaysYMD, formatDate, formatTime, hhmmToMinutes, minutesOfDaySP, minutesToHHMM, todaySP, toSaoPauloISO, ymdOf } from '../../lib/datetime'
import { actionLabel, categoryLabel, formatDuration, formatPhoneBR, toTitlePt, type ActionKey } from '../../lib/format'
import { formatBRL } from '../../lib/money'
import {
  invalidateAll,
  useAddons,
  useAvailability,
  useProfessionals,
  useProfessionalServices,
  useServices,
  useSuggestedProfessionals,
  type Addon,
  type Service,
} from '../../lib/queries'
import { messageOf, RpcError, rpc } from '../../lib/rpc'
import { useClientPackages } from '../../lib/clientQueries'
import { ClientPicker, type PickedClient } from '../clients/ClientPicker'
import { Link } from 'react-router-dom'

export interface Prefill {
  professionalId?: string
  date?: string
  minutes?: number
  client?: PickedClient
}

const CATEGORY_ORDER = ['unhas', 'cilios', 'sobrancelhas', 'outros']
const ACTION_ORDER: ActionKey[] = ['placement', 'maintenance', 'removal']

export function NewAppointmentSheet({ open, onClose, prefill }: { open: boolean; onClose: () => void; prefill?: Prefill }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Agenda" title="Novo agendamento">
      {open && <Body onClose={onClose} prefill={prefill} />}
    </Sheet>
  )
}

function actionsFor(services: Service[], category: string): ActionKey[] {
  const set = new Set<ActionKey>()
  for (const s of services) {
    if (s.category !== category) continue
    if (s.kind === 'removal') set.add('removal')
    else {
      set.add('placement')
      if (s.maintenance_price_cents !== null) set.add('maintenance')
    }
  }
  return ACTION_ORDER.filter((a) => set.has(a))
}

function matchesAction(s: Service, action: ActionKey): boolean {
  if (action === 'removal') return s.kind === 'removal'
  if (s.kind !== 'standard') return false
  return action === 'placement' || s.maintenance_price_cents !== null
}

function quote(svc: Service, action: ActionKey, addons: Addon[]) {
  const maint = action === 'maintenance'
  const baseDur = maint ? (svc.maintenance_duration_min ?? svc.duration_min) : svc.duration_min
  const basePrice = maint ? (svc.maintenance_price_cents ?? svc.price_cents) : svc.price_cents
  return {
    duration: baseDur + addons.reduce((n, a) => n + a.duration_delta_min, 0),
    total: basePrice + addons.reduce((n, a) => n + a.price_delta_cents, 0),
  }
}

function signedBRL(cents: number): string {
  return `${cents < 0 ? '−' : '+'} ${formatBRL(Math.abs(cents))}`
}

interface ClientContext {
  last_visit_at: string | null
  visit_count: number
  preferred_professional_id: string | null
}

function Body({ onClose, prefill }: { onClose: () => void; prefill?: Prefill }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const idempotencyKey = useRef(crypto.randomUUID()).current
  const today = todaySP()

  const services = useServices()
  const addons = useAddons()
  const links = useProfessionalServices()
  const professionals = useProfessionals()

  // ---- state
  const [client, setClient] = useState<PickedClient | null>(prefill?.client ?? null)
  const [category, setCategory] = useState<string | null>(null)
  const [action, setAction] = useState<ActionKey | null>(null)
  const [serviceId, setServiceId] = useState<string | null>(null)
  const [addonIds, setAddonIds] = useState<string[]>([])
  const [professionalId, setProfessionalId] = useState<string | null>(prefill?.professionalId ?? null)
  const [date, setDate] = useState(prefill?.date && prefill.date >= today ? prefill.date : today)
  const [slot, setSlot] = useState<string | null>(null)
  const [outside, setOutside] = useState(false)
  const [manualTime, setManualTime] = useState('')
  const [pending, setPending] = useState(false)
  const prefillMinutes = useRef<number | undefined>(prefill?.minutes)

  // ---- service selection (category -> action -> service)
  const active = useMemo(() => (services.data ?? []).filter((s) => s.active), [services.data])
  const categories = CATEGORY_ORDER.filter((c) => active.some((s) => s.category === c))
  const cat = category && categories.includes(category) ? category : (categories[0] ?? null)
  const actions = cat ? actionsFor(active, cat) : []
  const act = action && actions.includes(action) ? action : (actions[0] ?? null)
  const linkedIds = useMemo(
    () => new Set((links.data ?? []).filter((l) => l.professional_id === professionalId).map((l) => l.service_id)),
    [links.data, professionalId],
  )
  const serviceList = active.filter(
    (s) => s.category === cat && act && matchesAction(s, act) && (!professionalId || linkedIds.has(s.id)),
  )
  const service = serviceList.find((s) => s.id === serviceId) ?? null
  const serviceAddons = (addons.data ?? []).filter((a) => a.active && a.service_id === service?.id)
  const chosenAddons = serviceAddons.filter((a) => addonIds.includes(a.id))

  // ---- professional
  const suggested = useSuggestedProfessionals(client?.id ?? null, service?.id ?? null)
  const suggestions = suggested.data ?? []
  const habitualId = suggestions[0] && suggestions[0].visits > 0 ? suggestions[0].professional_id : null
  const proId =
    service && suggested.data && !suggestions.some((p) => p.professional_id === professionalId) ? null : professionalId

  useEffect(() => {
    if (!professionalId && habitualId) setProfessionalId(habitualId)
  }, [professionalId, habitualId])

  // ---- availability
  const availArgs = {
    professionalId: proId,
    serviceId: service?.id ?? null,
    action: act,
    addonIds: chosenAddons.map((a) => a.id),
    from: date,
    to: date,
  }
  const slots = useAvailability(availArgs)
  const slotList = slots.data ?? []
  const validSlot = slotList.some((s) => s.starts_at === slot) ? slot : null

  useEffect(() => {
    const min = prefillMinutes.current
    if (min === undefined || !slots.data || !service || !proId) return
    if (date !== prefill?.date) return
    prefillMinutes.current = undefined
    const hit = slots.data.find((s) => minutesOfDaySP(s.starts_at) === min)
    if (hit) setSlot(hit.starts_at)
    else {
      setOutside(true)
      setManualTime(minutesToHHMM(min))
    }
  }, [slots.data, service, proId, date, prefill?.date])

  const nextDay = useQuery({
    queryKey: ['availability', 'next-day', proId, service?.id, act, availArgs.addonIds.join(','), date],
    enabled: false,
    queryFn: () =>
      rpc.getAvailability({
        p_professional_id: proId!,
        p_service_id: service!.id,
        p_action: act!,
        p_addon_ids: availArgs.addonIds,
        p_from: addDaysYMD(date, 1),
        p_to: addDaysYMD(date, 14),
        p_source: 'staff',
      }),
  })

  async function findNextDay() {
    const r = await nextDay.refetch()
    const first = r.data?.[0]
    if (first) {
      setDate(ymdOf(first.starts_at, date))
      setSlot(first.starts_at)
    } else snack.show('Nenhum horário nos próximos 14 dias.', 'error')
  }

  // ---- package covering the selected service
  const clientPackages = useClientPackages(client?.id)
  const coveringPackage = service
    ? (clientPackages.data ?? []).find((p) => p.status === 'active' && p.remaining > 0 && p.service_id === service.id)
    : undefined
  const [usePackage, setUsePackage] = useState(false)
  const packageId = usePackage && coveringPackage ? coveringPackage.client_package_id : null

  // ---- summary + submit
  const quoted = service && act ? quote(service, act, chosenAddons) : null
  const summary = quoted && packageId ? { ...quoted, total: 0 } : quoted
  const startsAt = outside ? (manualTime ? toSaoPauloISO(date, manualTime) : null) : validSlot
  const canBook = !!(client && service && act && proId && startsAt) && !pending

  async function book() {
    if (!client || !service || !act || !proId || !startsAt) return
    setPending(true)
    try {
      await rpc.bookAppointment({
        p_client_id: client.id,
        p_professional_id: proId,
        p_service_id: service.id,
        p_action: act,
        p_addon_ids: chosenAddons.map((a) => a.id),
        p_starts_at: startsAt,
        p_source: 'staff',
        p_idempotency_key: idempotencyKey,
        p_notes: null,
        p_client_package_id: packageId,
        p_force: outside,
      })
      invalidateAll(qc)
      snack.show('Agendamento criado')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
      if (e instanceof RpcError && e.code === 'SLOT_TAKEN') {
        setSlot(null)
        void slots.refetch()
      }
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-8">
      <ClientSection client={client} onPick={setClient} onNavigate={onClose} professionals={professionals.data ?? []} />

      <section>
        <SectionHeader>Serviço</SectionHeader>
        {services.isLoading ? (
          <Skeleton className="h-11" />
        ) : (
          <div className="space-y-3">
            <TabList>
              {categories.map((c) => (
                <TabLabel key={c} active={c === cat} onClick={() => setCategory(c)}>
                  {categoryLabel(c)}
                </TabLabel>
              ))}
            </TabList>
            <TabList>
              {actions.map((a) => (
                <TabLabel key={a} active={a === act} onClick={() => setAction(a)}>
                  {actionLabel(a)}
                </TabLabel>
              ))}
            </TabList>
            {serviceList.length === 0 ? (
              <p className="text-help">Nenhum serviço ativo nesta combinação.</p>
            ) : (
              <ChipRow>
                {serviceList.map((s) => (
                  <Chip key={s.id} selected={s.id === service?.id} onClick={() => setServiceId(s.id)}>
                    {toTitlePt(s.name)}
                  </Chip>
                ))}
              </ChipRow>
            )}
          </div>
        )}
      </section>

      <section>
        <SectionHeader>Adicionais</SectionHeader>
        {!service ? (
          <p className="text-help">Escolha um serviço para ver os adicionais.</p>
        ) : serviceAddons.length === 0 ? (
          <p className="text-help">Este serviço não tem adicionais.</p>
        ) : (
          <ChipRow>
            {serviceAddons.map((a) => (
              <Chip
                key={a.id}
                selected={addonIds.includes(a.id)}
                onClick={() => setAddonIds((cur) => (cur.includes(a.id) ? cur.filter((x) => x !== a.id) : [...cur, a.id]))}
              >
                {a.name} {signedBRL(a.price_delta_cents)}
              </Chip>
            ))}
          </ChipRow>
        )}
      </section>

      <section>
        <SectionHeader>Profissional</SectionHeader>
        {!service ? (
          <p className="text-help">Escolha um serviço para ver as profissionais.</p>
        ) : suggested.isLoading ? (
          <Skeleton className="h-11" />
        ) : suggestions.length === 0 ? (
          <p className="text-help">Nenhuma profissional ativa realiza este serviço.</p>
        ) : (
          <ChipRow>
            {suggestions.map((p, i) => (
              <Chip key={p.professional_id} dot={p.color} selected={p.professional_id === proId} onClick={() => setProfessionalId(p.professional_id)}>
                {toTitlePt(p.name)}
                {i === 0 && habitualId ? ' · Habitual' : ''}
              </Chip>
            ))}
          </ChipRow>
        )}
      </section>

      <section>
        <SectionHeader>Dia e horário</SectionHeader>
        <div className="mb-4">
          <FieldLabel htmlFor="nb-date">Dia</FieldLabel>
          <Input id="nb-date" type="date" min={today} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </div>
        {!service || !proId ? (
          <p className="text-help">Escolha serviço e profissional para ver os horários.</p>
        ) : slots.isLoading ? (
          <Skeleton className="h-11" />
        ) : slotList.length === 0 ? (
          <EmptyState
            title="Sem horários neste dia"
            help="Não há horários livres para esta profissional e este serviço."
            action={
              <Button variant="secondary" loading={nextDay.isFetching} onClick={() => void findNextDay()}>
                Próximo dia com horário
              </Button>
            }
          />
        ) : (
          <ChipRow>
            {slotList.map((s) => (
              <Chip key={s.starts_at} selected={!outside && s.starts_at === validSlot} disabled={outside} onClick={() => setSlot(s.starts_at)}>
                {formatTime(s.starts_at)}
              </Chip>
            ))}
          </ChipRow>
        )}
      </section>

      <section className="rounded-[var(--radius-card)] border border-line p-4">
        <SectionHeader>Resumo</SectionHeader>
        {summary ? (
          <div className="flex items-baseline justify-between">
            <p className="text-base">{formatDuration(summary.duration)}</p>
            <p className="title-serif text-2xl">{formatBRL(summary.total)}</p>
          </div>
        ) : (
          <p className="text-help">Escolha um serviço.</p>
        )}
        {startsAt && (
          <p className="text-help mt-1">
            {formatDate(startsAt)} · {formatTime(startsAt)}
          </p>
        )}
        {coveringPackage && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <Kicker>
              Usar pacote ({coveringPackage.remaining}/{coveringPackage.sessions_total} restantes)
            </Kicker>
            <Toggle label="Usar pacote" checked={usePackage} onChange={setUsePackage} />
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-3">
          <Kicker>Fora do horário</Kicker>
          <Toggle label="Fora do horário" checked={outside} onChange={setOutside} />
        </div>
        {outside && (
          <div className="mt-2">
            <FieldLabel htmlFor="nb-manual">Horário</FieldLabel>
            <Input
              id="nb-manual"
              type="time"
              step={900}
              value={manualTime}
              onChange={(e) => setManualTime(hhmmToMinutes(e.target.value, -1) >= 0 ? e.target.value : '')}
            />
          </div>
        )}
      </section>

      <Button block disabled={!canBook} loading={pending} onClick={() => void book()}>
        Agendar
      </Button>
    </div>
  )
}

function ClientSection({
  client,
  onPick,
  onNavigate,
  professionals,
}: {
  client: PickedClient | null
  onPick: (c: PickedClient | null) => void
  onNavigate: () => void
  professionals: Array<{ id: string; name: string }>
}) {
  const snack = useSnackbar()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [birthday, setBirthday] = useState('')
  const [saving, setSaving] = useState(false)

  const ctx = useQuery({
    queryKey: ['client-context', client?.id],
    enabled: !!client,
    queryFn: async () => (await rpc.getClientContext({ p_client_id: client!.id })) as unknown as ClientContext,
  })

  async function saveClient() {
    setSaving(true)
    try {
      const id = await rpc.upsertClient({
        p_name: name.trim(),
        p_phone: phone.trim() || null,
        p_external_code: null,
        p_birthday: birthday || null,
        p_notes: null,
      })
      onPick({ id, name: name.trim(), phone: phone.trim() || null })
      setCreating(false)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  if (client) {
    const habitual = professionals.find((p) => p.id === ctx.data?.preferred_professional_id)
    return (
      <section>
        <SectionHeader
          action={
            <Button variant="ghost" onClick={() => onPick(null)}>
              Trocar
            </Button>
          }
        >
          Cliente
        </SectionHeader>
        <Link to={`/clientes/${client.id}`} onClick={onNavigate} className="title-serif text-xl underline decoration-line underline-offset-4">
          {toTitlePt(client.name)}
        </Link>
        <p className="text-help">{formatPhoneBR(client.phone)}</p>
        {ctx.data && (
          <p className="text-help mt-1">
            {ctx.data.last_visit_at ? `Última visita ${formatDate(ctx.data.last_visit_at)}` : 'Primeira visita'} ·{' '}
            {ctx.data.visit_count} {ctx.data.visit_count === 1 ? 'visita' : 'visitas'}
            {habitual ? ` · Habitual: ${toTitlePt(habitual.name)}` : ''}
          </p>
        )}
      </section>
    )
  }

  return (
    <section>
      <SectionHeader
        action={
          <Button variant="ghost" onClick={() => setCreating((v) => !v)}>
            {creating ? 'Buscar' : 'Nova cliente'}
          </Button>
        }
      >
        Cliente
      </SectionHeader>
      {creating ? (
        <div className="space-y-3">
          <div>
            <FieldLabel htmlFor="nc-name">Nome</FieldLabel>
            <Input id="nc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="nc-phone">Telefone</FieldLabel>
            <Input id="nc-phone" type="tel" inputMode="tel" placeholder="(11) 90000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
          <div>
            <FieldLabel htmlFor="nc-bday">Aniversário (opcional)</FieldLabel>
            <Input id="nc-bday" type="date" value={birthday} onChange={(e) => setBirthday(e.target.value)} />
          </div>
          <Button loading={saving} disabled={name.trim().length < 2} onClick={() => void saveClient()}>
            Salvar cliente
          </Button>
        </div>
      ) : (
        <ClientPicker onPick={onPick} />
      )}
    </section>
  )
}
