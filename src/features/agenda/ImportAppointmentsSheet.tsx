import { useQueryClient } from '@tanstack/react-query'
import { Download, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { Button, Kicker, Sheet, useSnackbar } from '../../components/ui'
import {
  parseAppointmentFile,
  planAppointments,
  problemsToCsv,
  runAppointmentImport,
  type AppointmentPlan,
  type AppointmentRunResult,
  type Sheet as FileSheet,
} from '../../lib/import/appointments'
import { fetchAppointmentKeys, fetchImportContext } from '../../lib/import/existing'
import { formatDateTime } from '../../lib/datetime'
import { invalidateAll } from '../../lib/queries'
import { messageOf, rpc } from '../../lib/rpc'

type Step =
  | { name: 'pick' }
  | { name: 'preview'; plan: AppointmentPlan; sheet: FileSheet }
  | { name: 'running'; done: number; total: number }
  | { name: 'result'; result: AppointmentRunResult }

/** Agenda › Importar (owner). CSV or Excel; preview, confirm, result. */
export function ImportAppointmentsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Agenda" title="Importar agendamentos">
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
  const [includePast, setIncludePast] = useState(false)

  async function plan(sheet: FileSheet, past: boolean) {
    const ctx = await fetchImportContext()
    const p = planAppointments(sheet, ctx, { includePast: past })
    if (p.missing.length > 0) throw new Error(`Não encontrei as colunas: ${p.missing.join(', ')}.`)
    setStep({ name: 'preview', plan: p, sheet })
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    if (!/\.(csv|xlsx?)$/i.test(file.name)) {
      snack.show('Escolha um arquivo .csv, .xls ou .xlsx', 'error')
      return
    }
    setBusy(true)
    try {
      const sheet = await parseAppointmentFile(file.name, await file.arrayBuffer())
      if (sheet.headers.length === 0) throw new Error('Arquivo vazio.')
      await plan(sheet, includePast)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  async function toggleInclude(sheet: FileSheet, past: boolean) {
    setIncludePast(past)
    try {
      await plan(sheet, past)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    }
  }

  async function confirm(p: AppointmentPlan) {
    setStep({ name: 'running', done: 0, total: p.rows.length })
    try {
      const result = await runAppointmentImport(
        p,
        { upsertClient: (a) => rpc.upsertClient(a), book: (a) => rpc.bookAppointment(a), existingKeys: await fetchAppointmentKeys() },
        (done, total) => setStep({ name: 'running', done, total }),
      )
      invalidateAll(qc)
      setStep({ name: 'result', result })
    } catch (e) {
      snack.show(messageOf(e), 'error')
      setStep({ name: 'pick' })
    }
  }

  function downloadProblems(result: AppointmentRunResult) {
    const blob = new Blob(['﻿' + problemsToCsv(result)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'erros-importacao-agendamentos.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (step.name === 'pick') {
    return (
      <div className="space-y-4">
        <p className="text-help">
          Arquivo CSV ou Excel com <strong>cliente</strong>, <strong>inicio</strong> (ou data + hora), <strong>servico</strong> e{' '}
          <strong>profissional</strong>. Opcionais: telefone, fim, status, valor, observacao. Só entram horários futuros; serviços e profissionais
          precisam existir no sistema. Duração e valor vêm do catálogo.
        </p>
        <label className="flex items-center gap-2 text-base">
          <input type="checkbox" checked={includePast} onChange={(e) => setIncludePast(e.target.checked)} />
          Incluir passados
        </label>
        <input
          ref={input}
          type="file"
          accept=".csv,.xls,.xlsx,text/csv"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <Button block loading={busy} icon={<Upload size={16} />} onClick={() => input.current?.click()}>
          Escolher arquivo
        </Button>
      </div>
    )
  }

  if (step.name === 'preview') {
    const { plan: p, sheet } = step
    const t = p.totals
    return (
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Linhas" value={t.rows} />
          <Stat label="Vão criar" value={t.create} />
          <Stat label="Clientes existentes" value={t.matchedClients} />
          <Stat label="Clientes novas" value={t.newClients} />
          <Stat label="Ignoradas" value={t.skipped} />
          <Stat label="Avisos" value={t.warnings} />
        </div>
        <label className="flex items-center gap-2 text-base">
          <input type="checkbox" checked={includePast} onChange={(e) => void toggleInclude(sheet, e.target.checked)} />
          Incluir passados
        </label>
        <div>
          <Kicker className="mb-2">Primeiras 10 linhas</Kicker>
          <ul className="space-y-2">
            {p.rows.slice(0, 10).map((r) => (
              <li key={r.line} className="rounded-[var(--radius-input)] border border-line px-3 py-2">
                <p className="text-base">
                  {r.clientName} <span className="label-caps">· {r.isNewClient ? 'cliente nova' : 'cliente existente'}</span>
                </p>
                <p className="text-help">
                  {formatDateTime(r.startsAt)} · {r.durationMin} min
                </p>
                {r.warnings.map((w) => (
                  <p key={w} className="text-help !text-warn">
                    {w}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </div>
        {p.skipped.length > 0 && (
          <div>
            <Kicker className="mb-2">Ignoradas (primeiras 10)</Kicker>
            <ul className="space-y-1">
              {p.skipped.slice(0, 10).map((s) => (
                <li key={s.line} className="text-help">
                  Linha {s.line} · {s.client || '(sem nome)'}: {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex gap-2">
          <Button disabled={t.create === 0} onClick={() => void confirm(p)}>
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
        <Stat label="Criados" value={r.created} />
        <Stat label="Já existiam" value={r.alreadyThere} />
        <Stat label="Ignorados" value={r.skipped.length} />
        <Stat label="Erros" value={r.errors.length} />
      </div>
      {r.skipped.length + r.errors.length > 0 && (
        <Button variant="secondary" icon={<Download size={16} />} onClick={() => downloadProblems(r)}>
          Baixar lista de erros (CSV)
        </Button>
      )}
      <Button block onClick={onClose}>
        Concluir
      </Button>
    </div>
  )
}
