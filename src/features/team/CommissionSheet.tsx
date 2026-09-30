import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button, FieldLabel, Input, Sheet, Skeleton, useSnackbar } from '../../components/ui'
import { formatPercent, parsePercent } from '../../lib/finance'
import { useCommissionRules } from '../../lib/financeQueries'
import { toTitlePt } from '../../lib/format'
import { invalidateAll, type Professional } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

type Cat = 'unhas' | 'cilios' | 'sobrancelhas' | 'outros'
const ROWS: Array<{ key: 'all' | Cat; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'unhas', label: 'Unhas' },
  { key: 'cilios', label: 'Cílios' },
  { key: 'sobrancelhas', label: 'Sobrancelhas' },
  { key: 'outros', label: 'Outros' },
]

/** Equipe › Comissão (owner): the professional's share per category; "Todas" is the fallback. */
export function CommissionSheet({ pro, onClose }: { pro: Professional | null; onClose: () => void }) {
  return (
    <Sheet open={!!pro} onClose={onClose} kicker="Comissão" title={pro ? toTitlePt(pro.name) : ''}>
      {pro && <Form pro={pro} onClose={onClose} />}
    </Sheet>
  )
}

function Form({ pro, onClose }: { pro: Professional; onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const rules = useCommissionRules()
  const [edited, setEdited] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)

  if (rules.isLoading) return <Skeleton className="h-40" />
  const initial = (key: string) => {
    const r = (rules.data ?? []).find((x) => x.professional_id === pro.id && (x.category ?? 'all') === key)
    return r ? formatPercent(r.percent) : ''
  }
  const value = (key: string) => edited[key] ?? initial(key)
  const changed = ROWS.filter((r) => value(r.key).trim() !== '' && value(r.key).trim() !== initial(r.key))
  const invalid = changed.some((r) => parsePercent(value(r.key)) === null)

  async function save() {
    setPending(true)
    try {
      for (const r of changed) {
        await rpc.setCommissionRule({
          p_professional_id: pro.id,
          p_category: r.key === 'all' ? null : r.key,
          p_percent: parsePercent(value(r.key))!,
        })
      }
      invalidateAll(qc)
      snack.show('Comissão salva')
      onClose()
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-help">
        Percentual que fica com a profissional. Uma categoria em branco usa a regra “Todas”. Mudar uma regra só preenche atendimentos que
        ainda estão sem comissão.
      </p>
      {ROWS.map((r) => (
        <div key={r.key}>
          <FieldLabel htmlFor={`cm-${r.key}`}>{r.label} (%)</FieldLabel>
          <Input
            id={`cm-${r.key}`}
            inputMode="decimal"
            placeholder="—"
            value={value(r.key)}
            onChange={(e) => setEdited((cur) => ({ ...cur, [r.key]: e.target.value }))}
          />
        </div>
      ))}
      {invalid && (
        <p role="alert" className="text-help !text-danger">
          Use um percentual entre 0 e 100, com até 2 casas decimais.
        </p>
      )}
      <Button block loading={pending} disabled={changed.length === 0 || invalid} onClick={() => void save()}>
        Salvar comissão
      </Button>
    </div>
  )
}
