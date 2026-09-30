import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthContext'
import { Button, FieldLabel, Input, MoneyInput, Select, Sheet, Toggle, useSnackbar } from '../../components/ui'
import { toTitlePt } from '../../lib/format'
import { formatBRL } from '../../lib/money'
import { invalidateAll, useServices } from '../../lib/queries'
import { usePackageTemplates, type PackageTemplate } from '../../lib/clientQueries'
import { messageOf, rpc } from '../../lib/rpc'
import { PaymentPanel, type PayTarget } from '../finance/PaymentSheet'
import { ClientPicker, type PickedClient } from '../clients/ClientPicker'

/** Vender pacote: client (search or prefilled) + active template → rpc_sell_package. */
export function SellPackageSheet({ open, client, onClose }: { open: boolean; client?: PickedClient | null; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Pacotes" title="Vender pacote">
      {open && <SellForm initial={client ?? null} onClose={onClose} />}
    </Sheet>
  )
}

function SellForm({ initial, onClose }: { initial: PickedClient | null; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const templates = usePackageTemplates()
  const services = useServices()
  const [client, setClient] = useState<PickedClient | null>(initial)
  const [templateId, setTemplateId] = useState('')
  const [pending, setPending] = useState(false)
  const { isOwner } = useAuth()
  // Owner: after the sale, the Payment sheet opens on the sale entry. A professional's sale leaves it open.
  const [payFor, setPayFor] = useState<PayTarget | null>(null)

  const active = (templates.data ?? []).filter((t) => t.active)
  const serviceName = (id: string) => toTitlePt(services.data?.find((s) => s.id === id)?.name)

  async function sell() {
    if (!client || !templateId) return
    setPending(true)
    try {
      const packageId = await rpc.sellPackage({ p_client_id: client.id, p_template_id: templateId })
      invalidateAll(qc)
      snack.show('Pacote vendido')
      const entry = isOwner ? await rpc.financeEntry({ p_appointment_id: null, p_client_package_id: packageId }) : null
      if (!entry) {
        onClose()
        return
      }
      const tpl = active.find((t) => t.id === templateId)
      setPayFor({
        mode: 'pay',
        entryId: entry.entry_id,
        title: toTitlePt(client.name),
        detail: tpl ? `${tpl.name} · ${tpl.sessions_total}x` : entry.description,
        grossCents: entry.amount_cents,
        discountCents: entry.discount_cents,
        paidCents: entry.paid_cents,
      })
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  if (payFor) return <PaymentPanel target={payFor} onDone={onClose} />

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>Cliente</FieldLabel>
        {client ? (
          <div className="flex items-center justify-between gap-3">
            <p className="title-serif text-xl">{toTitlePt(client.name)}</p>
            {!initial && (
              <Button variant="ghost" onClick={() => setClient(null)}>
                Trocar
              </Button>
            )}
          </div>
        ) : (
          <ClientPicker onPick={setClient} />
        )}
      </div>
      <div>
        <FieldLabel htmlFor="sp-template">Modelo</FieldLabel>
        <Select id="sp-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          <option value="">Escolha um modelo</option>
          {active.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} · {serviceName(t.service_id)} · {t.sessions_total}x · {formatBRL(t.price_cents)}
            </option>
          ))}
        </Select>
      </div>
      <Button block loading={pending} disabled={!client || !templateId} onClick={() => void sell()}>
        Vender pacote
      </Button>
    </div>
  )
}

/** Owner only. Edits always pass p_id. */
export function TemplateSheet({ open, template, onClose }: { open: boolean; template: PackageTemplate | null; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Pacotes" title={template ? 'Editar modelo' : 'Novo modelo'}>
      {open && <TemplateForm key={template?.id ?? 'new'} template={template} onClose={onClose} />}
    </Sheet>
  )
}

function TemplateForm({ template, onClose }: { template: PackageTemplate | null; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const services = useServices()
  const [name, setName] = useState(template?.name ?? '')
  const [serviceId, setServiceId] = useState(template?.service_id ?? '')
  const [sessions, setSessions] = useState(String(template?.sessions_total ?? 3))
  const [validity, setValidity] = useState(String(template?.validity_days ?? 90))
  const [price, setPrice] = useState<number | null>(template?.price_cents ?? null)
  const [active, setActive] = useState(template?.active ?? true)
  const [pending, setPending] = useState(false)

  const n = Number(sessions)
  const v = Number(validity)
  const valid = name.trim().length >= 2 && !!serviceId && Number.isInteger(n) && n > 0 && Number.isInteger(v) && v > 0 && price !== null

  async function save() {
    if (price === null) return
    setPending(true)
    try {
      await rpc.upsertPackageTemplate({
        p_id: template?.id ?? null,
        p_name: name.trim(),
        p_service_id: serviceId,
        p_sessions_total: n,
        p_validity_days: v,
        p_price_cents: price,
        p_active: active,
      })
      invalidateAll(qc)
      snack.show('Modelo salvo')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel htmlFor="pt-name">Nome</FieldLabel>
        <Input id="pt-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel htmlFor="pt-service">Serviço</FieldLabel>
        <Select id="pt-service" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          <option value="">Escolha um serviço</option>
          {(services.data ?? [])
            .filter((s) => s.active || s.id === template?.service_id)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {toTitlePt(s.name)}
              </option>
            ))}
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="pt-sessions">Sessões</FieldLabel>
          <Input id="pt-sessions" inputMode="numeric" value={sessions} onChange={(e) => setSessions(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <FieldLabel htmlFor="pt-validity">Validade (dias)</FieldLabel>
          <Input id="pt-validity" inputMode="numeric" value={validity} onChange={(e) => setValidity(e.target.value.replace(/\D/g, ''))} />
        </div>
      </div>
      <div>
        <FieldLabel htmlFor="pt-price">Preço</FieldLabel>
        <MoneyInput id="pt-price" value={price} onChange={setPrice} />
      </div>
      <div className="flex items-center justify-between">
        <FieldLabel>Ativo</FieldLabel>
        <Toggle label="Ativo" checked={active} onChange={setActive} />
      </div>
      <Button block loading={pending} disabled={!valid} onClick={() => void save()}>
        Salvar modelo
      </Button>
    </div>
  )
}
