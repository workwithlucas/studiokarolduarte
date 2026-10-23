// Pure helpers of the assistant history screens: log grouping by day, CSV export and the status labels.
import Papa from 'papaparse'
import type { ActionLogItem, ActionLogStatus } from '../../supabase/functions/_shared/assistant-types'
import { undoVisible } from '../../supabase/functions/_shared/assistant-state'
import { formatDate, formatTime, formatDayLong, ymdOf } from './datetime'
import { centsToPlain } from './money'

export type { ActionLogItem, ActionLogStatus }
export { undoVisible }

export const LOG_STATUS: Record<ActionLogStatus, { label: string; tone: 'success' | 'neutral' | 'danger' }> = {
  done: { label: 'FEITO', tone: 'success' },
  undone: { label: 'DESFEITO', tone: 'neutral' },
  failed: { label: 'FALHOU', tone: 'danger' },
}

export interface DayGroup {
  day: string
  label: string
  items: ActionLogItem[]
}

/** Groups rows (already newest first) by their São Paulo calendar day, keeping the order. Unreadable dates go last. */
export function groupActionsByDay(items: ActionLogItem[]): DayGroup[] {
  const groups: DayGroup[] = []
  const byDay = new Map<string, DayGroup>()
  for (const it of items) {
    const day = ymdOf(it.executed_at, '')
    let g = byDay.get(day)
    if (!g) {
      g = { day, label: day ? formatDayLong(day) : 'Data desconhecida', items: [] }
      byDay.set(day, g)
      groups.push(g)
    }
    g.items.push(it)
  }
  return groups
}

/** A cell that starts with = + - @ would run as a formula in a spreadsheet. */
const safeCell = (v: string): string => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v)

export function actionsToCsv(items: ActionLogItem[]): string {
  return Papa.unparse({
    fields: ['data', 'hora', 'resumo', 'valor', 'status'],
    data: items.map((a) => [
      formatDate(a.executed_at, ''),
      formatTime(a.executed_at, ''),
      safeCell(a.summary),
      a.amount_cents === null ? '' : centsToPlain(a.amount_cents),
      LOG_STATUS[a.status].label,
    ]),
  })
}
