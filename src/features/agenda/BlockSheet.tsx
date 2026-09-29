import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, Chip, ChipRow, FieldLabel, Input, Pill, Sheet, useSnackbar } from '../../components/ui'
import { formatDayLong, formatTime, todaySP, toSaoPauloISO, ymdOf } from '../../lib/datetime'
import { toTitlePt } from '../../lib/format'
import { invalidateAll, useProfessionals, type Block } from '../../lib/queries'
import { messageOf, RpcError, rpc } from '../../lib/rpc'

/** Strips the trailing "(uuid)" from each conflict entry raised by rpc_create_block. */
function parseConflicts(detail: string | null): string[] {
  if (!detail) return []
  return detail
    .replace(/^Agendamentos em conflito:\s*/, '')
    .split(';')
    .map((s) => s.replace(/\s*\([0-9a-f-]{36}\)\s*$/i, '').trim())
    .filter(Boolean)
}

export function BlockSheet({ open, onClose, date }: { open: boolean; onClose: () => void; date: string }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Agenda" title="Bloquear horário">
      {open && <CreateBody onClose={onClose} date={date} />}
    </Sheet>
  )
}

function CreateBody({ onClose, date }: { onClose: () => void; date: string }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const pros = useProfessionals()
  const [proId, setProId] = useState<string | 'all'>('all')
  const [day, setDay] = useState(date || todaySP())
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [pending, setPending] = useState(false)
  const [conflicts, setConflicts] = useState<string[] | null>(null)

  const startISO = start ? toSaoPauloISO(day, start) : null
  const endISO = end ? toSaoPauloISO(day, end) : null
  const valid = !!startISO && !!endISO && end > start

  async function submit(allow: boolean) {
    if (!startISO || !endISO) return
    setPending(true)
    try {
      await rpc.createBlock({
        p_professional_id: proId === 'all' ? null : proId,
        p_starts_at: startISO,
        p_ends_at: endISO,
        p_reason: reason.trim() || null,
        p_allow_conflicts: allow,
      })
      invalidateAll(qc)
      snack.show('Horário bloqueado')
      onClose()
    } catch (e) {
      if (e instanceof RpcError && e.code === 'BLOCK_CONFLICT') setConflicts(parseConflicts(e.detail))
      else snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <FieldLabel>Profissional</FieldLabel>
        <ChipRow>
          <Chip selected={proId === 'all'} onClick={() => setProId('all')}>
            Todo o studio
          </Chip>
          {(pros.data ?? [])
            .filter((p) => p.active)
            .map((p) => (
              <Chip key={p.id} dot={p.color} selected={proId === p.id} onClick={() => setProId(p.id)}>
                {toTitlePt(p.name)}
              </Chip>
            ))}
        </ChipRow>
      </div>
      <div>
        <FieldLabel htmlFor="bl-day">Dia</FieldLabel>
        <Input id="bl-day" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="bl-start">Início</FieldLabel>
          <Input id="bl-start" type="time" step={900} value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="bl-end">Fim</FieldLabel>
          <Input id="bl-end" type="time" step={900} value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      <div>
        <FieldLabel htmlFor="bl-reason">Motivo</FieldLabel>
        <Input id="bl-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>

      {conflicts && (
        <div role="alert" className="rounded-[var(--radius-input)] border border-danger/40 bg-danger/5 p-4">
          <p className="label-caps mb-2 !text-danger">Agendamentos em conflito</p>
          <ul className="mb-3 space-y-1 text-sm">
            {conflicts.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <Button variant="danger" loading={pending} onClick={() => void submit(true)}>
            Bloquear mesmo assim
          </Button>
        </div>
      )}

      <Button block disabled={!valid} loading={pending && !conflicts} onClick={() => void submit(false)}>
        Bloquear
      </Button>
    </div>
  )
}

export function BlockDetailSheet({ block, onClose }: { block: Block | null; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const pros = useProfessionals()
  const [pending, setPending] = useState(false)
  const pro = pros.data?.find((p) => p.id === block?.professional_id)

  async function remove() {
    if (!block) return
    setPending(true)
    try {
      await rpc.deleteBlock({ p_block_id: block.id })
      invalidateAll(qc)
      snack.show('Bloqueio removido')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet open={!!block} onClose={onClose} kicker="Bloqueio" title={block?.reason || 'Horário bloqueado'}>
      {block && (
        <div className="space-y-5">
          <Pill color={pro?.color}>{pro ? toTitlePt(pro.name) : 'Todo o studio'}</Pill>
          <p>
            {formatDayLong(block.starts_at)} · {formatTime(block.starts_at)} – {formatTime(block.ends_at)}
            {ymdOf(block.starts_at) !== ymdOf(block.ends_at) ? ' (até o dia seguinte)' : ''}
          </p>
          <Button variant="danger" loading={pending} onClick={() => void remove()}>
            Remover
          </Button>
        </div>
      )}
    </Sheet>
  )
}
