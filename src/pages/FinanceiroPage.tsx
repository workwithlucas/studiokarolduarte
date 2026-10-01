import { useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Download, MoreHorizontal, Plus, Upload } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Button,
  Chip,
  ChipRow,
  EmptyState,
  FieldLabel,
  Input,
  Kicker,
  Pill,
  SectionHeader,
  Select,
  Sheet,
  Skeleton,
  TabLabel,
  TabList,
  useSnackbar,
} from '../components/ui'
import { dayMonth } from '../features/clients/common'
import { useDebounced } from '../features/clients/common'
import {
  ActionSheet,
  ConfirmSheet,
  EditEntrySheet,
  NewEntrySheet,
  PaymentDetailSheet,
  type MenuAction,
} from '../features/finance/EntrySheets'
import { ClientCreditFlowSheet } from '../features/finance/ClientAccount'
import { ImportReceivablesSheet } from '../features/finance/ImportReceivablesSheet'
import { PaymentSheet, type PayTarget } from '../features/finance/PaymentSheet'
import { formatDate, todaySP, ymdOf } from '../lib/datetime'
import {
  ALL_METHODS,
  isNonCash,
  methodLabel,
  monthLabel,
  resolvePeriod,
  shiftMonth,
  statementToCsv,
  statusPill,
  totalsByMethod,
  type FinanceSummary,
} from '../lib/finance'
import { useFinanceList, useFinanceSummary, type FinanceRow } from '../lib/financeQueries'
import { toTitlePt } from '../lib/format'
import { formatBRL } from '../lib/money'
import { invalidateAll, useProfessionals } from '../lib/queries'
import { messageOf, rpc } from '../lib/rpc'

type Tab = 'mov' | 'ana'
type Seg = 'receber' | 'pagar' | 'extrato'
type Chipf = 'all' | 'overdue' | 'today' | 'expected' | 'partial'

const CHIPS: Array<{ key: Chipf; label: string }> = [
  { key: 'all', label: 'Todos' },
  { key: 'overdue', label: 'Vencidos' },
  { key: 'today', label: 'Hoje' },
  { key: 'expected', label: 'Previstos' },
  { key: 'partial', label: 'Parciais' },
]

export function FinanceiroPage() {
  const today = todaySP()
  const [ym, setYm] = useState(today.slice(0, 7))
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null)
  const [periodOpen, setPeriodOpen] = useState(false)
  const [proId, setProId] = useState('')
  const [method, setMethod] = useState('')
  const [tab, setTab] = useState<Tab>('mov')
  const [seg, setSeg] = useState<Seg>('receber')
  const [chip, setChip] = useState<Chipf>('all')
  const [term, setTerm] = useState('')
  const query = useDebounced(term.trim(), 250)
  const [importOpen, setImportOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [newKind, setNewKind] = useState<'expense' | 'income' | null>(null)
  const [creditOpen, setCreditOpen] = useState(false)

  const pros = useProfessionals()
  const { from, to } = resolvePeriod(ym, custom)
  const summary = useFinanceSummary(from, to, proId || null)
  const s = summary.data

  const inputCls = 'sm:w-auto'
  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Kicker className="mb-1">Studio</Kicker>
            <h1 className="title-serif text-3xl">Financeiro</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" icon={<Upload size={16} />} onClick={() => setImportOpen(true)}>
              Importar
            </Button>
            <Button icon={<Plus size={16} />} onClick={() => setMenuOpen(true)}>
              Lançamento
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <button type="button" aria-label="Mês anterior" onClick={() => { setCustom(null); setYm(shiftMonth(ym, -1)) }} className="hit inline-flex items-center justify-center rounded-full">
              <ChevronLeft size={20} />
            </button>
            <p className="title-serif min-w-40 text-center text-lg">{custom ? `${formatDate(from)} – ${formatDate(to)}` : monthLabel(ym)}</p>
            <button type="button" aria-label="Próximo mês" onClick={() => { setCustom(null); setYm(shiftMonth(ym, 1)) }} className="hit inline-flex items-center justify-center rounded-full">
              <ChevronRight size={20} />
            </button>
          </div>
          <Button variant="secondary" onClick={() => setPeriodOpen(true)}>
            Período
          </Button>
          <Select aria-label="Profissional" className={inputCls} value={proId} onChange={(e) => setProId(e.target.value)}>
            <option value="">Todas</option>
            {(pros.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {toTitlePt(p.name)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Forma de pagamento"
            title="Filtra o Extrato"
            className={inputCls}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
          >
            <option value="">Todas as formas</option>
            {ALL_METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
      </header>

      <Cards
        s={s}
        loading={summary.isLoading}
        onOverdue={() => {
          setTab('mov')
          setSeg('receber')
          setChip('overdue')
        }}
      />

      {s && s.warnings.missing_commission_rules > 0 && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-input)] border border-border-gold bg-surface-2 px-4 py-3">
          <p className="text-base">
            {s.warnings.missing_commission_rules} {s.warnings.missing_commission_rules === 1 ? 'atendimento sem' : 'atendimentos sem'} regra de comissão.
          </p>
          <Link to="/equipe" className="label-caps hit inline-flex items-center !text-ink underline">
            Definir em Equipe
          </Link>
        </div>
      )}

      <TabList>
        <TabLabel active={tab === 'mov'} onClick={() => setTab('mov')}>
          Movimento
        </TabLabel>
        <TabLabel active={tab === 'ana'} onClick={() => setTab('ana')}>
          Análise
        </TabLabel>
      </TabList>

      {tab === 'ana' ? (
        <Analysis s={s} loading={summary.isLoading} />
      ) : (
        <div className="space-y-4">
          <TabList>
            <TabLabel active={seg === 'receber'} onClick={() => setSeg('receber')}>
              A receber
            </TabLabel>
            <TabLabel active={seg === 'pagar'} onClick={() => setSeg('pagar')}>
              A pagar
            </TabLabel>
            <TabLabel active={seg === 'extrato'} onClick={() => setSeg('extrato')}>
              Extrato
            </TabLabel>
          </TabList>
          <Input aria-label="Buscar" placeholder="Buscar por cliente, serviço ou descrição" value={term} onChange={(e) => setTerm(e.target.value)} />
          {seg === 'receber' && <Receivables from={from} to={to} proId={proId} query={query} chip={chip} setChip={setChip} />}
          {seg === 'pagar' && <Payables from={from} to={to} query={query} />}
          {seg === 'extrato' && <Statement from={from} to={to} proId={proId} method={method} query={query} />}
        </div>
      )}

      <PeriodSheet
        open={periodOpen}
        from={from}
        to={to}
        onClose={() => setPeriodOpen(false)}
        onApply={(p) => {
          setCustom(p)
          setPeriodOpen(false)
        }}
        onMonth={() => {
          setCustom(null)
          setPeriodOpen(false)
        }}
      />
      <ImportReceivablesSheet open={importOpen} onClose={() => setImportOpen(false)} />
      <ActionSheet
        open={menuOpen}
        title="Novo lançamento"
        onClose={() => setMenuOpen(false)}
        actions={[
          { label: 'Nova despesa', onClick: () => setNewKind('expense') },
          { label: 'Receita avulsa', onClick: () => setNewKind('income') },
          { label: 'Crédito de cliente', onClick: () => setCreditOpen(true) },
        ]}
      />
      <NewEntrySheet kind={newKind} onClose={() => setNewKind(null)} />
      <ClientCreditFlowSheet open={creditOpen} onClose={() => setCreditOpen(false)} />
    </div>
  )
}

// ---------------------------------------------------------------- cards
function Cards({ s, loading, onOverdue }: { s: FinanceSummary | undefined; loading: boolean; onOverdue: () => void }) {
  if (loading || !s) return <Skeleton className="h-28" />
  const c = s.cards
  const box = 'rounded-[var(--radius-card)] border border-line bg-surface p-4 text-left shadow-card'
  return (
    <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Resumo do período">
      <div className={box}>
        <Kicker>Recebido (caixa)</Kicker>
        <p className="title-serif text-2xl">{formatBRL(c.received_cents)}</p>
        {s.barter_cents > 0 && <p className="text-help">+ {formatBRL(s.barter_cents)} em permuta</p>}
      </div>
      <div className={box}>
        <Kicker>A receber</Kicker>
        <p className="title-serif text-2xl">{formatBRL(c.receivable_cents)}</p>
      </div>
      <button type="button" onClick={onOverdue} className={`${box} hit`} aria-label="Ver vencidos">
        <Kicker>Vencido</Kicker>
        <p className={`title-serif text-2xl ${c.overdue_cents > 0 ? '!text-danger' : ''}`}>{formatBRL(c.overdue_cents)}</p>
      </button>
      <div className={box}>
        <Kicker>Resultado</Kicker>
        <p className="title-serif text-2xl">{formatBRL(c.result_cents)}</p>
        <p className="text-help">Saídas pagas: {formatBRL(c.expenses_paid_cents)}</p>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- period
function PeriodSheet({
  open,
  from,
  to,
  onClose,
  onApply,
  onMonth,
}: {
  open: boolean
  from: string
  to: string
  onClose: () => void
  onApply: (p: { from: string; to: string }) => void
  onMonth: () => void
}) {
  return (
    <Sheet open={open} onClose={onClose} kicker="Financeiro" title="Período">
      {open && <PeriodForm from={from} to={to} onApply={onApply} onMonth={onMonth} />}
    </Sheet>
  )
}

function PeriodForm({ from, to, onApply, onMonth }: { from: string; to: string; onApply: (p: { from: string; to: string }) => void; onMonth: () => void }) {
  const [a, setA] = useState(from)
  const [b, setB] = useState(to)
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="per-from">De</FieldLabel>
          <Input id="per-from" type="date" value={a} onChange={(e) => e.target.value && setA(e.target.value)} />
        </div>
        <div>
          <FieldLabel htmlFor="per-to">Até</FieldLabel>
          <Input id="per-to" type="date" value={b} onChange={(e) => e.target.value && setB(e.target.value)} />
        </div>
      </div>
      {a > b && (
        <p role="alert" className="text-help !text-danger">
          A data inicial deve ser antes da final.
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={a > b} onClick={() => onApply({ from: a, to: b })}>
          Aplicar
        </Button>
        <Button variant="ghost" onClick={onMonth}>
          Usar o mês
        </Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- shared row helpers
function payTargetOf(r: FinanceRow): PayTarget {
  const expense = r.kind === 'expense'
  const who = r.client_name ? toTitlePt(r.client_name) : r.description
  const detail = r.service_name ? toTitlePt(r.service_name) : r.description
  if (r.appointment_id && r.appointment_status !== 'completed') {
    return {
      mode: 'complete',
      appointmentId: r.appointment_id,
      clientId: r.client_id,
      day: ymdOf(r.appointment_starts_at),
      title: who,
      detail,
      grossCents: r.amount_cents,
      discountCents: r.discount_cents,
      paidCents: r.paid_cents,
    }
  }
  return {
    mode: 'pay',
    entryId: r.entry_id,
    clientId: r.client_id,
    title: who,
    detail: `${detail} · vence ${formatDate(r.due_date)}`,
    grossCents: r.amount_cents,
    discountCents: r.discount_cents,
    paidCents: r.paid_cents,
    kind: expense ? 'expense' : 'income',
  }
}

/** Row menu state + the sheets it opens (pay, edit, void). One instance per list. */
function useRowActions() {
  const qc = useQueryClient()
  const snack = useSnackbar()
  const [menu, setMenu] = useState<{ row: FinanceRow; actions: MenuAction[] } | null>(null)
  const [pay, setPay] = useState<PayTarget | null>(null)
  const [edit, setEdit] = useState<FinanceRow | null>(null)
  const [confirmVoid, setConfirmVoid] = useState<FinanceRow | null>(null)
  const [pending, setPending] = useState(false)

  async function doVoid(r: FinanceRow) {
    setPending(true)
    try {
      await rpc.voidEntry({ p_entry_id: r.entry_id })
      invalidateAll(qc)
      snack.show(r.kind === 'expense' ? 'Despesa excluída' : 'Lançamento cancelado')
      setConfirmVoid(null)
    } catch (e) {
      snack.show(messageOf(e), 'error')
    } finally {
      setPending(false)
    }
  }

  function open(r: FinanceRow, voidLabel: string) {
    const pill = statusPill(r, r.kind)
    const linked = !!(r.appointment_id || r.client_package_id)
    setMenu({
      row: r,
      actions: [
        { label: 'Dar baixa', disabled: !pill.payable, onClick: () => setPay(payTargetOf(r)) },
        { label: 'Editar', onClick: () => setEdit(r) },
        {
          label: voidLabel,
          danger: true,
          onClick: () =>
            linked
              ? snack.show('Cancele o agendamento ou o pacote para cancelar este lançamento.', 'error')
              : setConfirmVoid(r),
        },
      ],
    })
  }

  const sheets = (
    <>
      <ActionSheet open={!!menu} title={menu ? (menu.row.client_name ? toTitlePt(menu.row.client_name) : menu.row.description) : ''} actions={menu?.actions ?? []} onClose={() => setMenu(null)} />
      <PaymentSheet target={pay} onClose={() => setPay(null)} />
      <EditEntrySheet row={edit} onClose={() => setEdit(null)} />
      <ConfirmSheet
        open={!!confirmVoid}
        title={confirmVoid?.kind === 'expense' ? 'Excluir despesa' : 'Cancelar lançamento'}
        confirmLabel={confirmVoid?.kind === 'expense' ? 'Excluir' : 'Cancelar lançamento'}
        pending={pending}
        onConfirm={() => confirmVoid && void doVoid(confirmVoid)}
        onClose={() => setConfirmVoid(null)}
      >
        {confirmVoid?.description}
      </ConfirmSheet>
    </>
  )
  return { open, sheets }
}

function MoreButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" aria-label="Ações" onClick={onClick} className="hit inline-flex shrink-0 items-center justify-center rounded-full">
      <MoreHorizontal size={20} />
    </button>
  )
}

// ---------------------------------------------------------------- A RECEBER
function Receivables({
  from,
  to,
  proId,
  query,
  chip,
  setChip,
}: {
  from: string
  to: string
  proId: string
  query: string
  chip: Chipf
  setChip: (c: Chipf) => void
}) {
  const list = useFinanceList({ mode: 'receivable', from, to, status: chip === 'all' ? null : chip, professionalId: proId || null, query })
  const actions = useRowActions()
  const today = todaySP()
  const rows = list.data ?? []
  const groups = [
    { title: 'Vencidos', rows: rows.filter((r) => r.due_date < today) },
    { title: 'Hoje', rows: rows.filter((r) => r.due_date === today) },
    { title: 'Próximos', rows: rows.filter((r) => r.due_date > today) },
  ].filter((g) => g.rows.length > 0)

  return (
    <div className="space-y-4">
      <ChipRow>
        {CHIPS.map((c) => (
          <Chip key={c.key} selected={chip === c.key} onClick={() => setChip(c.key)}>
            {c.label}
          </Chip>
        ))}
      </ChipRow>
      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nada a receber" help="Nenhum lançamento em aberto neste período." />
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.title}>
              <SectionHeader>{g.title}</SectionHeader>
              <ul className="space-y-2">
                {g.rows.map((r) => {
                  const pill = statusPill(r, 'income')
                  return (
                    <li key={r.entry_id} className="flex items-center gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="title-serif truncate text-lg">{r.client_name ? toTitlePt(r.client_name) : r.description}</p>
                        <p className="text-help truncate">
                          {dayMonth(r.due_date)}
                          {r.professional_name ? ` · ${toTitlePt(r.professional_name)}` : ''}
                          {` · ${r.service_name ? toTitlePt(r.service_name) : r.description}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <Pill tone={pill.tone}>{pill.label}</Pill>
                        <p className="title-serif text-lg">{formatBRL(r.open_cents)}</p>
                      </div>
                      <MoreButton onClick={() => actions.open(r, 'Cancelar lançamento')} />
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
          <p className="text-help text-right">Em aberto: {formatBRL(rows[0]?.sum_cents ?? 0)}</p>
        </>
      )}
      {actions.sheets}
    </div>
  )
}

// ---------------------------------------------------------------- A PAGAR
function Payables({ from, to, query }: { from: string; to: string; query: string }) {
  const list = useFinanceList({ mode: 'payable', from, to, query })
  const actions = useRowActions()
  const rows = list.data ?? []

  return (
    <div className="space-y-4">
      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <EmptyState title="Nenhuma despesa" help="Use + Lançamento › Nova despesa para registrar uma saída." />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((r) => {
              const pill = statusPill(r, 'expense')
              return (
                <li key={r.entry_id} className="flex items-center gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="title-serif truncate text-lg">{r.description}</p>
                    <p className="text-help truncate">
                      {r.category ?? 'Sem categoria'} · vence {formatDate(r.due_date)}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Pill tone={pill.tone}>{pill.label}</Pill>
                    <p className="title-serif text-lg">{formatBRL(r.final_cents)}</p>
                  </div>
                  <MoreButton onClick={() => actions.open(r, 'Excluir')} />
                </li>
              )
            })}
          </ul>
          <p className="text-help text-right">Em aberto: {formatBRL(rows[0]?.sum_cents ?? 0)}</p>
        </>
      )}
      {actions.sheets}
    </div>
  )
}

// ---------------------------------------------------------------- EXTRATO
const STATEMENT_LIMIT = 500

function Statement({ from, to, proId, method, query }: { from: string; to: string; proId: string; method: string; query: string }) {
  const snack = useSnackbar()
  const [reversed, setReversed] = useState(false)
  const [detail, setDetail] = useState<FinanceRow | null>(null)
  const list = useFinanceList({ mode: 'statement', from, to, status: method || null, professionalId: proId || null, query, includeReversed: reversed, limit: STATEMENT_LIMIT })
  const rows = useMemo(() => list.data ?? [], [list.data])
  const totals = useMemo(() => totalsByMethod(rows), [rows])

  function exportCsv() {
    const blob = new Blob(['﻿' + statementToCsv(rows)], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `extrato-${from}-${to}.csv`
    a.click()
    URL.revokeObjectURL(url)
    snack.show('Extrato exportado')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={reversed} onChange={(e) => setReversed(e.target.checked)} className="size-5" />
          <span className="label-caps">Mostrar estornos</span>
        </label>
        <Button variant="secondary" icon={<Download size={16} />} disabled={rows.length === 0} onClick={exportCsv}>
          Exportar CSV
        </Button>
      </div>
      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <EmptyState title="Sem recebimentos" help="Nenhum pagamento neste período." />
      ) : (
        <>
          <ul className="space-y-2">
            {rows.map((r) => (
              <li key={r.payment_id} className={r.reversed_at ? 'opacity-50' : ''}>
                <button
                  type="button"
                  onClick={() => setDetail(r)}
                  className="hit flex w-full items-center gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <p className="title-serif truncate text-lg">{r.client_name ? toTitlePt(r.client_name) : r.description}</p>
                    <p className="text-help truncate">
                      {dayMonth(r.paid_at)}
                      {r.professional_name ? ` · ${toTitlePt(r.professional_name)}` : ''}
                      {r.reversed_at ? ' · estornado' : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Pill tone={r.method === 'barter' ? 'primary' : 'neutral'}>{methodLabel(r.method)}</Pill>
                    <p className={`title-serif text-lg ${isNonCash(r.method) ? 'text-muted' : ''}`}>{formatBRL(r.payment_cents)}</p>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {(rows[0]?.total_count ?? 0) > rows.length && <p className="text-help">Mostrando os {rows.length} mais recentes. Reduza o período para ver o restante.</p>}
          <div className="rounded-[var(--radius-input)] border border-border-gold bg-surface-2 px-4 py-3">
            <Kicker className="mb-2">Totais por forma</Kicker>
            <ul className="space-y-1">
              {totals.list.map((t) => (
                <li key={t.method} className="flex justify-between">
                  <span>{t.label}</span>
                  <span className="title-serif">{formatBRL(t.cents)}</span>
                </li>
              ))}
              <li className="flex justify-between border-t border-line pt-1">
                <span className="label-caps">Total</span>
                <span className="title-serif">{formatBRL(totals.total)}</span>
              </li>
            </ul>
            {totals.noncash.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <Kicker className="mb-2">Fora do caixa</Kicker>
                <ul className="space-y-1">
                  {totals.noncash.map((t) => (
                    <li key={t.method} className="flex justify-between">
                      <span>{t.label}</span>
                      <span className="title-serif">{formatBRL(t.cents)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
      <PaymentDetailSheet row={detail} onClose={() => setDetail(null)} />
    </div>
  )
}

// ---------------------------------------------------------------- ANÁLISE
function Analysis({ s, loading }: { s: FinanceSummary | undefined; loading: boolean }) {
  if (loading || !s) return <Skeleton className="h-64" />
  const th = 'label-caps py-2 text-right first:text-left'
  const td = 'py-2 text-right first:text-left'
  return (
    <div className="space-y-8">
      <section>
        <SectionHeader>Produção por profissional</SectionHeader>
        {s.by_professional.length === 0 ? (
          <p className="text-help">Nenhum atendimento concluído no período.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-96 text-base">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>Profissional</th>
                  <th className={th}>Atend.</th>
                  <th className={th}>Produção</th>
                  <th className={th}>Comissão</th>
                  <th className={th}>Studio</th>
                </tr>
              </thead>
              <tbody>
                {s.by_professional.map((p) => (
                  <tr key={p.professional_id} className="border-b border-line">
                    <td className={td}>{toTitlePt(p.name)}</td>
                    <td className={td}>{p.count}</td>
                    <td className={td}>{formatBRL(p.production_cents)}</td>
                    <td className={td}>{formatBRL(p.commission_cents)}</td>
                    <td className={td}>{formatBRL(p.studio_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionHeader>Caixa por forma</SectionHeader>
        <table className="w-full max-w-md text-base">
          <tbody>
            {s.by_method.length === 0 && (
              <tr>
                <td className="text-help py-2">Nenhum recebimento no período.</td>
              </tr>
            )}
            {s.by_method.map((m) => (
              <tr key={m.method} className="border-b border-line">
                <td className={td}>{methodLabel(m.method)}</td>
                <td className={td}>{m.count}</td>
                <td className={td}>{formatBRL(m.cents)}</td>
              </tr>
            ))}
            {s.barter_cents > 0 && (
              <tr className="border-b border-line">
                <td className={td}>{methodLabel('barter')} (fora do caixa)</td>
                <td className={td} />
                <td className={td}>{formatBRL(s.barter_cents)}</td>
              </tr>
            )}
          </tbody>
        </table>
        {s.noncash_by_method.length > 0 && (
          <div className="mt-4">
            <Kicker className="mb-1">Fora do caixa</Kicker>
            <table className="w-full max-w-md text-base">
              <tbody>
                {s.noncash_by_method.map((m) => (
                  <tr key={m.method} className="border-b border-line">
                    <td className={td}>{methodLabel(m.method)}</td>
                    <td className={td}>{m.count}</td>
                    <td className={td}>{formatBRL(m.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionHeader>Contas de clientes</SectionHeader>
        <dl className="grid max-w-md grid-cols-2 gap-3">
          <div>
            <Kicker>Créditos</Kicker>
            <p className="title-serif text-xl">{formatBRL(s.accounts.credit_total_cents)}</p>
          </div>
          <div>
            <Kicker>Dívidas em aberto</Kicker>
            <p className="title-serif text-xl">{formatBRL(s.accounts.open_debt_total_cents)}</p>
          </div>
        </dl>
        {s.accounts.top.length > 0 && (
          <ul className="mt-3 max-w-md space-y-2">
            {s.accounts.top.map((t) => (
              <li key={t.client_id}>
                <Link to={`/clientes/${t.client_id}`} className="hit flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                  <span className="title-serif truncate text-lg">{toTitlePt(t.client)}</span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-2">
                    {t.balance_cents > 0 && <Pill tone="success">Crédito {formatBRL(t.balance_cents)}</Pill>}
                    {t.debt_cents > 0 && <Pill tone="danger">Em aberto {formatBRL(t.debt_cents)}</Pill>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <SectionHeader>Pacotes</SectionHeader>
        <dl className="grid max-w-md grid-cols-3 gap-3">
          <div>
            <Kicker>Vendidos</Kicker>
            <p className="title-serif text-xl">{s.packages.sold_count}</p>
          </div>
          <div>
            <Kicker>Valor</Kicker>
            <p className="title-serif text-xl">{formatBRL(s.packages.sold_cents)}</p>
          </div>
          <div>
            <Kicker>Sessões usadas</Kicker>
            <p className="title-serif text-xl">{s.packages.sessions_used}</p>
          </div>
        </dl>
      </section>

      <section>
        <SectionHeader>Saídas por categoria</SectionHeader>
        <table className="w-full max-w-md text-base">
          <tbody>
            {s.expenses_by_category.length === 0 && (
              <tr>
                <td className="text-help py-2">Nenhuma saída paga no período.</td>
              </tr>
            )}
            {s.expenses_by_category.map((c) => (
              <tr key={c.category} className="border-b border-line">
                <td className={td}>{c.category}</td>
                <td className={td}>{formatBRL(c.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
