import { useQueryClient } from '@tanstack/react-query'
import { useMemo, useRef, useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, SectionHeader, Skeleton, TabLabel, TabList, useSnackbar } from '../../components/ui'
import { endTimeLabel, parseDurationInput } from '../../lib/editAppointment'
import { actionLabel, categoryLabel, toTitlePt, type ActionKey } from '../../lib/format'
import { invalidateAll, useAddons, useProfessionalServices, useServices, type AppointmentRow, type Service } from '../../lib/queries'
import { rpc } from '../../lib/rpc'
import { errorText, LocalBoundary } from './AdjustTime'

const CATEGORY_ORDER = ['unhas', 'cilios', 'sobrancelhas', 'outros']
const ACTION_ORDER: ActionKey[] = ['placement', 'maintenance', 'removal']

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

function quoteMinutes(svc: Service, action: ActionKey, addonMinutes: number): number {
  const base = action === 'maintenance' ? (svc.maintenance_duration_min ?? svc.duration_min) : svc.duration_min
  return base + addonMinutes
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** "Alterar serviço" + "Duração": one save, one rpc_edit_appointment. Starts_at never changes here. */
export function EditAppointmentPanel({ a, onBack, onClose }: { a: AppointmentRow; onBack: () => void; onClose: () => void }) {
  return (
    <LocalBoundary onBack={onBack}>
      <Body a={a} onBack={onBack} onClose={onClose} />
    </LocalBoundary>
  )
}

function Body({ a, onBack, onClose }: { a: AppointmentRow; onBack: () => void; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const services = useServices()
  const addons = useAddons()
  const links = useProfessionalServices()
  const originalAddons = useMemo(() => a.addons.map((x) => x.addon_id).sort(), [a.addons])

  const [category, setCategory] = useState<string | null>(a.service?.category ?? null)
  const [action, setAction] = useState<ActionKey | null>(a.action)
  const [serviceId, setServiceId] = useState<string>(a.service_id)
  const [addonIds, setAddonIds] = useState<string[]>(originalAddons)
  const [durationText, setDurationText] = useState(String(a.duration_min))
  const [durationTouched, setDurationTouched] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // one request id per distinct attempt: a retry after a lost response never edits twice
  const request = useRef<{ key: string; id: string } | null>(null)

  const linkedIds = useMemo(
    () => new Set((links.data ?? []).filter((l) => l.professional_id === a.professional_id).map((l) => l.service_id)),
    [links.data, a.professional_id],
  )
  // the current service stays selectable even if it was deactivated since
  const pool = useMemo(
    () => (services.data ?? []).filter((s) => s.id === a.service_id || (s.active && linkedIds.has(s.id))),
    [services.data, linkedIds, a.service_id],
  )
  const categories = CATEGORY_ORDER.filter((c) => pool.some((s) => s.category === c))
  const cat = category && categories.includes(category) ? category : (categories[0] ?? null)
  const actions = cat ? actionsFor(pool, cat) : []
  const act = action && actions.includes(action) ? action : (actions[0] ?? null)
  const serviceList = pool.filter((s) => s.category === cat && act && matchesAction(s, act))
  const service = serviceList.find((s) => s.id === serviceId) ?? null
  const serviceAddons = (addons.data ?? []).filter((x) => x.active && x.service_id === service?.id)
  const chosen = serviceAddons.filter((x) => addonIds.includes(x.id))

  const serviceChanged =
    !!service && !!act && (service.id !== a.service_id || act !== a.action || !sameSet([...addonIds].sort(), originalAddons))
  const quoted = serviceChanged && service && act ? quoteMinutes(service, act, chosen.reduce((n, x) => n + x.duration_delta_min, 0)) : null

  // until the field is typed in, it shows the duration the chosen service would give
  const shownDuration = durationTouched ? durationText : quoted !== null ? String(quoted) : String(a.duration_min)
  const typed = parseDurationInput(shownDuration)
  const durationBad = shownDuration.trim() !== '' && typed === null
  const endLabel = typed !== null ? endTimeLabel(a.starts_at, typed) : null

  const baseline = quoted ?? a.duration_min
  const durationToSend = durationTouched && typed !== null && typed !== baseline ? typed : null
  const durationChanged = durationToSend !== null && (durationToSend !== a.duration_min || !a.duration_overridden)
  const canSave = !pending && !durationBad && (serviceChanged || durationChanged) && (!serviceChanged || quoted !== null)

  function pickAction(x: ActionKey) {
    setAction(x)
    setServiceId('')
    setAddonIds([])
  }
  function pickCategory(c: string) {
    setCategory(c)
    setAction(null)
    setServiceId('')
    setAddonIds([])
  }
  function pickService(id: string) {
    setServiceId(id)
    setAddonIds(id === a.service_id ? originalAddons : [])
  }

  async function save() {
    if (!canSave) return
    const args = {
      p_appointment_id: a.id,
      p_service_id: serviceChanged && service && service.id !== a.service_id ? service.id : null,
      p_service_action: serviceChanged && act && act !== a.action ? act : null,
      p_addon_ids: serviceChanged ? chosen.map((x) => x.id) : null,
      p_duration_min: durationToSend,
    }
    const key = JSON.stringify(args)
    if (request.current?.key !== key) request.current = { key, id: crypto.randomUUID() }
    setPending(true)
    setError(null)
    try {
      await rpc.editAppointment({ ...args, p_request_id: request.current.id })
    } catch (e) {
      setError(errorText(e))
      setPending(false)
      return
    }
    invalidateAll(qc)
    snack.show('Agendamento atualizado')
    setPending(false)
    onClose()
  }

  if (services.isLoading || addons.isLoading || links.isLoading) return <Skeleton className="h-40" />

  return (
    <div className="space-y-6">
      <section>
        <SectionHeader>Serviço</SectionHeader>
        <div className="space-y-3">
          <TabList>
            {categories.map((c) => (
              <TabLabel key={c} active={c === cat} onClick={() => pickCategory(c)}>
                {categoryLabel(c)}
              </TabLabel>
            ))}
          </TabList>
          <TabList>
            {actions.map((x) => (
              <TabLabel key={x} active={x === act} onClick={() => pickAction(x)}>
                {actionLabel(x)}
              </TabLabel>
            ))}
          </TabList>
          {serviceList.length === 0 ? (
            <p className="text-help">Nenhum serviço ativo nesta combinação.</p>
          ) : (
            <ChipRow>
              {serviceList.map((s) => (
                <Chip key={s.id} selected={s.id === service?.id} onClick={() => pickService(s.id)}>
                  {toTitlePt(s.name)}
                </Chip>
              ))}
            </ChipRow>
          )}
        </div>
      </section>

      <section>
        <SectionHeader>Adicionais</SectionHeader>
        {!service ? (
          <p className="text-help">Escolha um serviço para ver os adicionais.</p>
        ) : serviceAddons.length === 0 ? (
          <p className="text-help">Este serviço não tem adicionais.</p>
        ) : (
          <ChipRow>
            {serviceAddons.map((x) => (
              <Chip
                key={x.id}
                selected={addonIds.includes(x.id)}
                onClick={() => setAddonIds((cur) => (cur.includes(x.id) ? cur.filter((y) => y !== x.id) : [...cur, x.id]))}
              >
                {x.name}
              </Chip>
            ))}
          </ChipRow>
        )}
        {serviceChanged && service && service.id !== a.service_id && (
          <p className="text-help mt-2">Os adicionais do serviço anterior não são mantidos.</p>
        )}
      </section>

      <section>
        <FieldLabel htmlFor="edit-duration">Duração (minutos)</FieldLabel>
        <Input
          id="edit-duration"
          inputMode="numeric"
          autoComplete="off"
          maxLength={3}
          value={shownDuration}
          aria-invalid={durationBad}
          onChange={(e) => {
            setDurationTouched(true)
            setDurationText(e.target.value.replace(/\D/g, '').slice(0, 3))
          }}
        />
        <p className={`mt-2 ${durationBad ? 'text-help !text-danger' : 'text-help'}`} aria-live="polite">
          {durationBad ? 'Use de 5 a 600 minutos.' : endLabel ? `Termina às ${endLabel}` : ''}
        </p>
      </section>

      {error && (
        <p role="alert" className="text-help !text-danger">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button loading={pending} disabled={!canSave} onClick={() => void save()}>
          Salvar
        </Button>
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
      </div>
    </div>
  )
}
