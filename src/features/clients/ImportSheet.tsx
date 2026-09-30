import { useQueryClient } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Kicker, Sheet, useSnackbar } from '../../components/ui'
import { errorsToCsv, decodeCsv, parseCsv, planImport, runImport, type ImportPlan, type RunResult } from '../../lib/import/clients'
import { fetchExistingClients } from '../../lib/import/existing'
import { formatPhoneBR } from '../../lib/format'
import { invalidateAll } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

type Step =
  | { name: 'pick' }
  | { name: 'preview'; plan: ImportPlan; existingIds: Set<string> }
  | { name: 'running'; done: number; total: number }
  | { name: 'result'; result: RunResult }

/** Clientes › Importar (owner). CSV only; preview, confirm, result. */
export function ImportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Clientes" title="Importar clientes">
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
      const existing = await fetchExistingClients()
      const plan = planImport(parsed, existing)
      if (plan.missing.length > 0) throw new Error('Não encontrei a coluna "nome" no arquivo.')
      setStep({ name: 'preview', plan, existingIds: new Set(existing.map((c) => c.id)) })
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function confirm(plan: ImportPlan, existingIds: Set<string>) {
    setStep({ name: 'running', done: 0, total: plan.totals.rows - plan.totals.skipped })
    const result = await runImport(plan, (a) => rpc.upsertClient(a), existingIds, (done, total) => setStep({ name: 'running', done, total }))
    invalidateAll(qc)
    setStep({ name: 'result', result })
  }

  function downloadErrors(result: RunResult) {
    const blob = new Blob(['﻿' + errorsToCsv(result.errors)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'erros-importacao.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (step.name === 'pick') {
    return (
      <div className="space-y-4">
        <p className="text-help">
          Arquivo CSV com a coluna <strong>nome</strong> (obrigatória) e, se quiser: telefone, aniversario, codigo, observacoes, credito.
        </p>
        <input ref={input} type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
        <Button block loading={busy} icon={<Upload size={16} />} onClick={() => input.current?.click()}>
          Escolher arquivo CSV
        </Button>
      </div>
    )
  }

  if (step.name === 'preview') {
    const { plan, existingIds } = step
    const t = plan.totals
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Linhas" value={t.rows} />
          <Stat label="Criar" value={t.create} />
          <Stat label="Já existentes" value={t.match} />
          <Stat label="Avisos" value={t.warnings} />
          <Stat label="Ignoradas" value={t.skipped} />
        </div>
        <div>
          <Kicker className="mb-2">Primeiras 10 linhas</Kicker>
          <ul className="space-y-2">
            {plan.rows.slice(0, 10).map((r) => (
              <li key={r.line} className="rounded-[var(--radius-input)] border border-line px-3 py-2">
                <p className="text-base">
                  {r.name || '(sem nome)'} <span className="label-caps">· {r.status === 'create' ? 'criar' : r.status === 'match' ? 'já existe' : 'ignorar'}</span>
                </p>
                <p className="text-help">{r.phone ? formatPhoneBR(r.phone) : 'sem telefone'}</p>
                {r.warnings.map((w) => (
                  <p key={w} className="text-help !text-warn">
                    {w}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex gap-2">
          <Button disabled={t.rows - t.skipped === 0} onClick={() => void confirm(plan, existingIds)}>
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
        <Stat label="Criadas" value={r.created} />
        <Stat label="Já existentes" value={r.matched} />
        <Stat label="Ignoradas" value={r.skipped} />
        <Stat label="Erros" value={r.errors.length} />
      </div>
      {r.errors.length > 0 && (
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
