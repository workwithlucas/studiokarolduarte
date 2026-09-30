import { Kicker, Pill, SectionHeader, Skeleton } from '../../components/ui'
import { formatDate } from '../../lib/datetime'
import { methodLabel } from '../../lib/finance'
import { useFinanceList, WIDE_FROM, WIDE_TO } from '../../lib/financeQueries'
import { toTitlePt } from '../../lib/format'
import { formatBRL } from '../../lib/money'

/** Client page › FINANCEIRO (owner only): open balance and the last 10 payments, both from rpc_finance_list. */
export function ClientFinance({ clientId }: { clientId: string }) {
  const open = useFinanceList({ mode: 'receivable', from: WIDE_FROM, to: WIDE_TO, clientId, limit: 1 })
  const payments = useFinanceList({ mode: 'statement', from: WIDE_FROM, to: WIDE_TO, clientId, limit: 10 })
  const balance = open.data?.[0]?.sum_cents ?? 0

  return (
    <section>
      <SectionHeader>Financeiro</SectionHeader>
      {open.isLoading || payments.isLoading ? (
        <Skeleton className="h-24" />
      ) : (
        <div className="space-y-4">
          <div>
            <Kicker>Saldo em aberto</Kicker>
            <p className={`title-serif text-2xl ${balance > 0 ? '!text-danger' : ''}`}>{formatBRL(balance)}</p>
          </div>
          {(payments.data ?? []).length === 0 ? (
            <p className="text-help">Nenhum pagamento registrado.</p>
          ) : (
            <ul className="space-y-2">
              {(payments.data ?? []).map((p) => (
                <li key={p.payment_id} className="flex items-center justify-between gap-3 rounded-[var(--radius-input)] border border-line bg-surface px-4 py-3">
                  <div className="min-w-0">
                    <p className="title-serif truncate text-lg">{p.service_name ? toTitlePt(p.service_name) : p.description}</p>
                    <p className="text-help">{formatDate(p.paid_at)}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Pill>{methodLabel(p.method)}</Pill>
                    <p className="title-serif text-lg">{formatBRL(p.payment_cents)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
