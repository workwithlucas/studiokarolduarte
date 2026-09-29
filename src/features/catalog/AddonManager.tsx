import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Chip, ChipRow, EmptyState, FieldLabel, Input, Kicker, MoneyInput, Pill, SectionHeader, Sheet, Toggle, useSnackbar } from '../../components/ui'
import { formatDuration, toTitlePt } from '../../lib/format'
import { formatBRL } from '../../lib/money'
import { invalidateCatalog, useAddons, type Addon, type Service } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

export function AddonManagerSheet({ service, canEdit, onClose }: { service: Service | null; canEdit: boolean; onClose: () => void }) {
  return (
    <Sheet open={!!service} onClose={onClose} kicker="Adicionais" title={service ? toTitlePt(service.name) : ''}>
      {service && <Body service={service} canEdit={canEdit} />}
    </Sheet>
  )
}

function signed(cents: number) {
  return `${cents < 0 ? '−' : '+'} ${formatBRL(Math.abs(cents))}`
}

function Body({ service, canEdit }: { service: Service; canEdit: boolean }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const addons = useAddons()
  const rows = (addons.data ?? []).filter((a) => a.service_id === service.id)
  const [editing, setEditing] = useState<Addon | 'new' | null>(null)

  async function toggle(a: Addon, active: boolean) {
    try {
      await rpc.upsertAddon({
        p_id: a.id,
        p_service_id: a.service_id,
        p_name: a.name,
        p_price_delta_cents: a.price_delta_cents,
        p_duration_delta_min: a.duration_delta_min,
        p_active: active,
      })
      invalidateCatalog(qc)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    }
  }

  if (editing) {
    return <AddonForm service={service} addon={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        action={
          canEdit && (
            <Button variant="secondary" onClick={() => setEditing('new')}>
              Novo adicional
            </Button>
          )
        }
      >
        Adicionais do serviço
      </SectionHeader>
      {rows.length === 0 ? (
        <EmptyState title="Sem adicionais" help="Este serviço ainda não tem adicionais cadastrados." />
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.id} className={`flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line p-3 ${a.active ? '' : 'opacity-60'}`}>
              <div className="min-w-0">
                <p className="title-serif text-lg">{a.name}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Pill>{signed(a.price_delta_cents)}</Pill>
                  {a.duration_delta_min !== 0 && <Pill>{formatDuration(a.duration_delta_min)}</Pill>}
                </div>
              </div>
              {canEdit && (
                <div className="flex items-center gap-1">
                  <Button variant="ghost" onClick={() => setEditing(a)}>
                    Editar
                  </Button>
                  <Toggle label={`Ativar ${a.name}`} checked={a.active} onChange={(v) => void toggle(a, v)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function AddonForm({ service, addon, onDone }: { service: Service; addon: Addon | null; onDone: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [name, setName] = useState(addon?.name ?? '')
  const [discount, setDiscount] = useState((addon?.price_delta_cents ?? 0) < 0)
  const [price, setPrice] = useState<number | null>(addon ? Math.abs(addon.price_delta_cents) : null)
  const [pending, setPending] = useState(false)
  const [negMin, setNegMin] = useState((addon?.duration_delta_min ?? 0) < 0)
  const [absMin, setAbsMin] = useState(String(Math.abs(addon?.duration_delta_min ?? 0)))

  async function save() {
    setPending(true)
    try {
      const cents = (price ?? 0) * (discount ? -1 : 1)
      const mins = Number(absMin || '0') * (negMin ? -1 : 1)
      await rpc.upsertAddon({
        p_id: addon?.id ?? null,
        p_service_id: service.id,
        p_name: name.trim(),
        p_price_delta_cents: cents,
        p_duration_delta_min: mins,
        p_active: addon?.active ?? true,
      })
      invalidateCatalog(qc)
      snack.show('Adicional salvo')
      onDone()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <Kicker>{addon ? 'Editar adicional' : 'Novo adicional'}</Kicker>
      <div>
        <FieldLabel htmlFor="ad-name">Nome</FieldLabel>
        <Input id="ad-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel>Preço</FieldLabel>
        <ChipRow>
          <Chip selected={!discount} onClick={() => setDiscount(false)}>
            Acréscimo
          </Chip>
          <Chip selected={discount} onClick={() => setDiscount(true)}>
            Desconto
          </Chip>
        </ChipRow>
        <div className="mt-2">
          <MoneyInput value={price} onChange={setPrice} />
        </div>
      </div>
      <div>
        <FieldLabel>Tempo (min)</FieldLabel>
        <ChipRow>
          <Chip selected={!negMin} onClick={() => setNegMin(false)}>
            Mais tempo
          </Chip>
          <Chip selected={negMin} onClick={() => setNegMin(true)}>
            Menos tempo
          </Chip>
        </ChipRow>
        <div className="mt-2">
          <Input inputMode="numeric" value={absMin} onChange={(e) => setAbsMin(e.target.value.replace(/\D/g, ''))} />
        </div>
      </div>
      <div className="flex gap-2">
        <Button loading={pending} disabled={name.trim().length < 2} onClick={() => void save()}>
          Salvar
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Voltar
        </Button>
      </div>
    </div>
  )
}
