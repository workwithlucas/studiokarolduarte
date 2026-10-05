import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Kicker, Skeleton } from '../components/ui'
import { monthBounds, monthLabel, shiftMonth } from '../lib/finance'
import { useMyFinanceSummary } from '../lib/financeQueries'
import { todaySP } from '../lib/datetime'
import { formatBRL } from '../lib/money'

// Professional view: own totals only (two cards). No list, no client names, no statement.
export function MyFinancePage() {
  const [ym, setYm] = useState(todaySP().slice(0, 7))
  const { from, to } = monthBounds(ym)
  const q = useMyFinanceSummary(from, to)
  const box = 'rounded-[var(--radius-card)] border border-line bg-surface p-4 text-left shadow-card'

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div>
          <Kicker className="mb-1">Studio</Kicker>
          <h1 className="title-serif text-3xl">Financeiro</h1>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Mês anterior" onClick={() => setYm(shiftMonth(ym, -1))} className="hit inline-flex items-center justify-center rounded-full">
            <ChevronLeft size={20} />
          </button>
          <p className="title-serif min-w-40 text-center text-lg">{monthLabel(ym)}</p>
          <button type="button" aria-label="Próximo mês" onClick={() => setYm(shiftMonth(ym, 1))} className="hit inline-flex items-center justify-center rounded-full">
            <ChevronRight size={20} />
          </button>
        </div>
      </header>

      {q.isLoading ? (
        <Skeleton className="h-28" />
      ) : q.isError ? (
        <p className="text-help" role="alert">Não foi possível carregar. Tente novamente.</p>
      ) : (
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-label="Resumo do mês">
          <div className={box}>
            <Kicker>FATURAMENTO DO MÊS</Kicker>
            <p className="title-serif text-2xl">{formatBRL(q.data?.gross_cents)}</p>
          </div>
          <div className={box}>
            <Kicker>TOTAL A REPASSAR AO STUDIO</Kicker>
            <p className="title-serif text-2xl">{formatBRL(q.data?.studio_share_cents)}</p>
          </div>
        </section>
      )}
    </div>
  )
}
