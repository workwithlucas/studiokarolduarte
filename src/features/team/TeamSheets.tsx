import { useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, Kicker, Sheet, Toggle, useSnackbar } from '../../components/ui'
import { hhmmToMinutes } from '../../lib/datetime'
import { categoryLabel, safeColor, toTitlePt } from '../../lib/format'
import { invalidateCatalog, useProfessionalServices, useServices, useWorkingHours, type Professional } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

// ---------------------------------------------------------------- name + colour
const SWATCHES = ['#B57A88', '#6F8F7A', '#C9963F', '#5A2138', '#7C8FB5', '#B5473F', '#8B6FA8', '#4F8A8B']

/** `pro` null = new professional (p_id null creates role 'professional'). */
export function ProfessionalFormSheet({ open, pro, onClose }: { open: boolean; pro: Professional | null; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Equipe" title={pro ? 'Editar profissional' : 'Novo profissional'}>
      {open && <NameColorForm key={pro?.id ?? 'new'} pro={pro} onClose={onClose} />}
    </Sheet>
  )
}

function NameColorForm({ pro, onClose }: { pro: Professional | null; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [name, setName] = useState(pro?.name ?? '')
  const [color, setColor] = useState(safeColor(pro?.color, SWATCHES[0]))
  const [pending, setPending] = useState(false)

  async function save() {
    setPending(true)
    try {
      await rpc.upsertProfessional({ p_id: pro?.id ?? null, p_name: name.trim(), p_color: color, p_active: pro?.active ?? true })
      invalidateCatalog(qc)
      snack.show('Profissional salva')
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
        <FieldLabel htmlFor="pr-name">Nome</FieldLabel>
        <Input id="pr-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <FieldLabel>Cor</FieldLabel>
        <ChipRow>
          {SWATCHES.map((c) => (
            <Chip key={c} dot={c} selected={color.toLowerCase() === c.toLowerCase()} onClick={() => setColor(c)}>
              {' '}
            </Chip>
          ))}
        </ChipRow>
        <input
          type="color"
          aria-label="Cor personalizada"
          value={color}
          onChange={(e) => setColor(e.target.value)}
          className="hit mt-3 w-full cursor-pointer rounded-[var(--radius-input)] border border-line bg-surface p-1"
        />
      </div>
      <Button block disabled={name.trim().length < 2} loading={pending} onClick={() => void save()}>
        Salvar
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- linked services
export function ProfessionalServicesSheet({ pro, onClose }: { pro: Professional | null; onClose: () => void }) {
  return (
    <Sheet open={!!pro} onClose={onClose} kicker="Serviços" title={pro ? toTitlePt(pro.name) : ''}>
      {pro && <ServicesForm pro={pro} onClose={onClose} />}
    </Sheet>
  )
}

function ServicesForm({ pro, onClose }: { pro: Professional; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const services = useServices()
  const links = useProfessionalServices()
  const [picked, setPicked] = useState<string[] | null>(null)
  const [pending, setPending] = useState(false)

  const current = picked ?? (links.data ?? []).filter((l) => l.professional_id === pro.id).map((l) => l.service_id)
  const toggle = (id: string) => setPicked(current.includes(id) ? current.filter((x) => x !== id) : [...current, id])

  async function save() {
    setPending(true)
    try {
      await rpc.setProfessionalServices({ p_professional_id: pro.id, p_service_ids: current })
      invalidateCatalog(qc)
      snack.show('Serviços salvos')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  const byCategory = ['unhas', 'cilios', 'sobrancelhas', 'outros'].map((c) => ({
    c,
    rows: (services.data ?? []).filter((s) => s.category === c),
  }))

  return (
    <div className="space-y-6">
      {byCategory
        .filter((g) => g.rows.length > 0)
        .map((g) => (
          <div key={g.c}>
            <FieldLabel>{categoryLabel(g.c)}</FieldLabel>
            <ChipRow>
              {g.rows.map((s) => (
                <Chip key={s.id} selected={current.includes(s.id)} onClick={() => toggle(s.id)}>
                  {toTitlePt(s.name)}
                </Chip>
              ))}
            </ChipRow>
          </div>
        ))}
      <Button block loading={pending} onClick={() => void save()}>
        Salvar
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------- weekly hours
const DAYS: Array<{ weekday: number; label: string }> = [
  { weekday: 1, label: 'Segunda' },
  { weekday: 2, label: 'Terça' },
  { weekday: 3, label: 'Quarta' },
  { weekday: 4, label: 'Quinta' },
  { weekday: 5, label: 'Sexta' },
  { weekday: 6, label: 'Sábado' },
  { weekday: 0, label: 'Domingo' },
]

interface Range {
  start: string
  end: string
}
type Week = Record<number, Range[]>

export function WorkingHoursSheet({ pro, onClose }: { pro: Professional | null; onClose: () => void }) {
  return (
    <Sheet open={!!pro} onClose={onClose} kicker="Horários" title={pro ? toTitlePt(pro.name) : ''}>
      {pro && <HoursForm pro={pro} onClose={onClose} />}
    </Sheet>
  )
}

function dayError(ranges: Range[]): boolean {
  const parsed = ranges.map((r) => ({ s: hhmmToMinutes(r.start, -1), e: hhmmToMinutes(r.end, -1) }))
  if (parsed.some((r) => r.s < 0 || r.e < 0 || r.e <= r.s)) return true
  const sorted = [...parsed].sort((a, b) => a.s - b.s)
  return sorted.some((r, i) => i > 0 && r.s < sorted[i - 1].e)
}

function HoursForm({ pro, onClose }: { pro: Professional; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const hours = useWorkingHours()
  const [edited, setEdited] = useState<Week | null>(null)
  const [pending, setPending] = useState(false)

  const stored: Week = {}
  for (const h of (hours.data ?? []).filter((x) => x.professional_id === pro.id)) {
    ;(stored[h.weekday] ??= []).push({ start: h.start_time.slice(0, 5), end: h.end_time.slice(0, 5) })
  }
  const week = edited ?? stored
  const set = (weekday: number, ranges: Range[]) => setEdited({ ...week, [weekday]: ranges })

  const invalid = DAYS.some((d) => dayError(week[d.weekday] ?? []))

  async function save() {
    setPending(true)
    try {
      const rows = DAYS.flatMap((d) =>
        (week[d.weekday] ?? []).map((r) => ({ weekday: d.weekday, start_time: r.start, end_time: r.end })),
      )
      await rpc.setWorkingHours({ p_professional_id: pro.id, p_rows: rows })
      invalidateCatalog(qc)
      snack.show('Horários salvos')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      {DAYS.map((d) => {
        const ranges = week[d.weekday] ?? []
        const off = ranges.length === 0
        return (
          <div key={d.weekday} className="rounded-[var(--radius-input)] border border-line p-3">
            <div className="flex items-center justify-between">
              <Kicker>{d.label}</Kicker>
              <div className="flex items-center gap-2">
                <span className="label-caps">{off ? 'Folga' : 'Trabalha'}</span>
                <Toggle
                  label={`${d.label} trabalha`}
                  checked={!off}
                  onChange={(on) => set(d.weekday, on ? [{ start: '', end: '' }] : [])}
                />
              </div>
            </div>
            {ranges.map((r, i) => (
              <div key={i} className="mt-2 flex items-center gap-2">
                <Input
                  type="time"
                  aria-label="Início"
                  value={r.start}
                  onChange={(e) => set(d.weekday, ranges.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))}
                />
                <Input
                  type="time"
                  aria-label="Fim"
                  value={r.end}
                  onChange={(e) => set(d.weekday, ranges.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))}
                />
                <button
                  type="button"
                  aria-label="Remover faixa"
                  onClick={() => set(d.weekday, ranges.filter((_, j) => j !== i))}
                  className="hit inline-flex shrink-0 items-center justify-center rounded-full"
                >
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
            {!off && dayError(ranges) && <p className="text-help mt-2 !text-danger">Confira os horários: início antes do fim, sem sobreposição.</p>}
            {!off && (
              <Button variant="ghost" icon={<Plus size={16} />} onClick={() => set(d.weekday, [...ranges, { start: '', end: '' }])}>
                Adicionar faixa
              </Button>
            )}
          </div>
        )
      })}
      <Button block disabled={invalid} loading={pending} onClick={() => void save()}>
        Salvar horários
      </Button>
    </div>
  )
}
