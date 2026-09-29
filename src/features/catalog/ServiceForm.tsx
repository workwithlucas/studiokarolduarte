import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, MoneyInput, Sheet, Toggle, useSnackbar, Kicker } from '../../components/ui'
import { categoryLabel } from '../../lib/format'
import { invalidateCatalog, type Service } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

type Category = Service['category']
type Kind = Service['kind']
const CATEGORIES: Category[] = ['unhas', 'cilios', 'sobrancelhas', 'outros']

/** `service` null = new service. Edits always pass p_id (update in place). */
export function ServiceFormSheet({ open, service, onClose }: { open: boolean; service: Service | null; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Catálogo" title={service ? 'Editar serviço' : 'Novo serviço'}>
      {open && <Form key={service?.id ?? 'new'} service={service} onClose={onClose} />}
    </Sheet>
  )
}

function Form({ service, onClose }: { service: Service | null; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [name, setName] = useState(service?.name ?? '')
  const [category, setCategory] = useState<Category>(service?.category ?? 'unhas')
  const [kind, setKind] = useState<Kind>(service?.kind ?? 'standard')
  const [duration, setDuration] = useState(String(service?.duration_min ?? 60))
  const [price, setPrice] = useState<number | null>(service?.price_cents ?? null)
  const [mDuration, setMDuration] = useState(service?.maintenance_duration_min ? String(service.maintenance_duration_min) : '')
  const [mPrice, setMPrice] = useState<number | null>(service?.maintenance_price_cents ?? null)
  const [cash, setCash] = useState<number | null>(service?.cash_price_cents ?? null)
  const [active, setActive] = useState(service?.active ?? true)
  const [pending, setPending] = useState(false)

  const removal = kind === 'removal'
  const dur = Number(duration)
  const mDur = mDuration === '' ? null : Number(mDuration)
  const maintenanceOk = removal || ((mDur === null) === (mPrice === null) && (mDur === null || (Number.isInteger(mDur) && mDur > 0)))
  const valid = name.trim().length >= 2 && Number.isInteger(dur) && dur > 0 && price !== null && maintenanceOk

  async function save() {
    if (price === null) return
    setPending(true)
    try {
      await rpc.upsertService({
        p_id: service?.id ?? null,
        p_name: name.trim(),
        p_category: category,
        p_kind: kind,
        p_duration_min: dur,
        p_price_cents: price,
        p_maintenance_duration_min: removal ? null : mDur,
        p_maintenance_price_cents: removal ? null : mPrice,
        p_cash_price_cents: cash,
        p_active: active,
      })
      invalidateCatalog(qc)
      snack.show('Serviço salvo')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel htmlFor="sv-name">Nome</FieldLabel>
        <Input id="sv-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel>Categoria</FieldLabel>
        <ChipRow>
          {CATEGORIES.map((c) => (
            <Chip key={c} selected={category === c} onClick={() => setCategory(c)}>
              {categoryLabel(c)}
            </Chip>
          ))}
        </ChipRow>
      </div>
      <div>
        <FieldLabel>Tipo</FieldLabel>
        <ChipRow>
          <Chip selected={kind === 'standard'} onClick={() => setKind('standard')}>
            Padrão
          </Chip>
          <Chip selected={kind === 'removal'} onClick={() => setKind('removal')}>
            Remoção avulsa
          </Chip>
        </ChipRow>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="sv-dur">Duração (min)</FieldLabel>
          <Input id="sv-dur" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div>
          <FieldLabel htmlFor="sv-price">{removal ? 'Preço' : 'Colocação'}</FieldLabel>
          <MoneyInput id="sv-price" value={price} onChange={setPrice} />
        </div>
      </div>
      {!removal && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor="sv-mdur">Manutenção (min)</FieldLabel>
            <Input id="sv-mdur" inputMode="numeric" value={mDuration} onChange={(e) => setMDuration(e.target.value.replace(/\D/g, ''))} />
          </div>
          <div>
            <FieldLabel htmlFor="sv-mprice">Manutenção</FieldLabel>
            <MoneyInput id="sv-mprice" value={mPrice} onChange={setMPrice} />
          </div>
          {!maintenanceOk && <p className="text-help col-span-2 !text-danger">Informe duração e preço da manutenção, ou deixe os dois em branco.</p>}
        </div>
      )}
      <div>
        <FieldLabel htmlFor="sv-cash">À vista</FieldLabel>
        <MoneyInput id="sv-cash" value={cash} onChange={setCash} />
      </div>
      <div className="flex items-center justify-between">
        <Kicker>Ativo</Kicker>
        <Toggle label="Ativo" checked={active} onChange={setActive} />
      </div>
      <Button block disabled={!valid} loading={pending} onClick={() => void save()}>
        Salvar
      </Button>
    </div>
  )
}
