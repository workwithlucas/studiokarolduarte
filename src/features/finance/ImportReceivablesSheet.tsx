import { useQueryClient } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Kicker, Sheet, useSnackbar } from '../../components/ui'
import { formatDate } from '../../lib/datetime'
import { formatBRL } from '../../lib/money'
import { decodeCsv, parseCsv } from '../../lib/import/clients'
import { fetchExistingClients } from '../../lib/import/existing'
import {
  planReceivables,
  receivableProblemsToCsv,
  runReceivableImport,
  type ReceivablePlan,
  type ReceivableRunResult,
} from '../../lib/import/receivables'
import { invalidateAll } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

type Step =
  | { name: 'pick' }
  | { name: 'preview'; plan: ReceivablePlan; existingKeys: Set<string> }
  | { name: 'running'; done: number; total: number }
  | { name: 'result'; result: ReceivableRunResult }

/** Financeiro › Importar (owner). CSV only; preview, confirm in chunks of 25, result with an error CSV. */
export function ImportReceivablesSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Financeiro" title="Importar a receber">
      {open && <Flow onClose={onClose} />}
    </Sheet>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-input)] border border-line px-3 py-2">
      <Kicker>{label}</Kicker>
      <p className="title-serif text-2xl">{value}</p>
    </div>
  )
}

function Flow({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const input = useRef<HTMLInputElement>(null)
  const [step, setStep] = useState<Step>({ name: 'pick' })
  const [busy, setBusy] = useState(false)

  async function onFile(file: File | undefined) {
    if (!file) return
    if (!/\.csv$/i.test(file.name)) {
      snack.show('Escolha um arquivo .csv', 'error')
      return
    }
    setBusy(true)
    try {
      const parsed = parseCsv(decodeCsv(await file.arrayBuffer()))
      if (parsed.headers.length === 0) throw new Error('Arquivo vazio.')
      const clients = await fetchExistingClients()
      const plan = await planReceivables(parsed, clients)
      if (plan.missing.length > 0) throw new Error('Faltam colunas: cliente (ou nome), vencimento (ou data) e valor.')
      const existing = await rpc.financeImportKeys({ p_keys: plan.rows.map((r) => r.key) })
      setStep({ name: 'preview', plan, existingKeys: new Set(existing) })
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function confirm(plan: ReceivablePlan, existingKeys: Set<string>) {
    setStep({ name: 'running', done: 0, total: plan.rows.length })
    const result = await runReceivableImport(plan, (a) => rpc.createManualEntry(a), existingKeys, (done, total) =>
      setStep({ name: 'running', done, total }),
    )
    invalidateAll(qc)
    setStep({ name: 'result', result })
  }

  function downloadErrors(result: ReceivableRunResult) {
    const blob = new Blob(['﻿' + receivableProblemsToCsv(result)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'erros-importacao-a-receber.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (step.name === 'pick') {
    return (
      <div className="space-y-4">
        <p className="text-help">
          Arquivo CSV com as colunas <strong>cliente</strong> (ou nome), <strong>vencimento</strong> (ou data) e <strong>valor</strong>;
          opcional: <strong>descricao</strong> (ou obs). A cliente precisa já estar cadastrada: linhas sem correspondência são ignoradas e
          listadas.
        </p>
        <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <Button block loading={busy} icon={<Upload size={16} />} onClick={() => input.current?.click()}>
          Escolher arquivo CSV
        </Button>
      </div>
    )
  }

  if (step.name === 'preview') {
    const { plan, existingKeys } = step
    const already = plan.rows.filter((r) => existingKeys.has(r.key)).length
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Linhas" value={plan.totals.rows} />
          <Stat label="Lançar" value={plan.rows.length - already} />
          <Stat label="Já lançadas" value={already} />
          <Stat label="Ignoradas" value={plan.skipped.length} />
        </div>
        <div>
          <Kicker className="mb-2">Primeiras 10 linhas</Kicker>
          <ul className="space-y-2">
            {plan.rows.slice(0, 10).map((r) => (
              <li key={r.line} className="rounded-[var(--radius-input)] border border-line px-3 py-2">
                <p className="text-base">
                  {r.clientName} <span className="label-caps">· {existingKeys.has(r.key) ? 'já lançada' : 'lançar'}</span>
                </p>
                <p className="text-help">
                  {formatDate(r.due)} · {formatBRL(r.amountCents)} · {r.description}
                </p>
              </li>
            ))}
          </ul>
        </div>
        {plan.skipped.length > 0 && (
          <div>
            <Kicker className="mb-2">Ignoradas</Kicker>
            <ul className="space-y-1">
              {plan.skipped.slice(0, 10).map((s) => (
                <li key={s.line} className="text-help !text-warn">
                  Linha {s.line}: {s.client || '(sem cliente)'} — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Button disabled={plan.rows.length === 0} onClick={() => void confirm(plan, existingKeys)}>
            Confirmar importação
          </Button>
          <Button variant="ghost" onClick={() => setStep({ name: 'pick' })}>
            Voltar
          </Button>
        </div>
      </div>
    )
  }

  if (step.name === 'running') {
    const pct = step.total === 0 ? 100 : Math.round((step.done / step.total) * 100)
    return (
      <div className="space-y-3">
        <p className="text-base">
          Importando… {step.done}/{step.total}
        </p>
        <div className="h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary-bg" style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  const r = step.result
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Lançadas" value={r.created} />
        <Stat label="Já lançadas" value={r.alreadyThere} />
        <Stat label="Ignoradas" value={r.skipped.length} />
        <Stat label="Erros" value={r.errors.length} />
      </div>
      {r.skipped.length + r.errors.length > 0 && (
        <Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadErrors(r)}>
          Baixar lista de erros (CSV)
        </Button>
      )}
      <Button block onClick={onClose}>
        Concluir
      </Button>
    </div>
  )
}
