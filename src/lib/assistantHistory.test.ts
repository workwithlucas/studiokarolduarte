import { describe, expect, it } from 'vitest'
import { inArchivedThread, pageSize, threadTitle } from '../../supabase/functions/_shared/assistant-state'
import { actionsToCsv, groupActionsByDay, undoVisible, type ActionLogItem } from './assistantHistory'

const row = (over: Partial<ActionLogItem> = {}): ActionLogItem => ({
  pending_id: 'p1', action_index: 0, kind: 'create_entry', summary: 'Despesa lançada', amount_cents: 2000, entry_id: null, client_name: null,
  status: 'done', error_code: null, executed_at: '2026-10-23T15:30:00Z', undone_at: null, undoable: true, ...over,
})

describe('thread title', () => {
  it('is the first 60 characters of the first user message, whitespace collapsed', () => {
    expect(threadTitle('Lançar despesa de gás')).toBe('Lançar despesa de gás')
    expect(threadTitle('x'.repeat(100))).toHaveLength(60)
    expect(threadTitle('  duas\n linhas   aqui ')).toBe('duas linhas aqui')
  })
  it('has a fallback when there is no user message', () => {
    expect(threadTitle(null)).toBe('Conversa sem título')
    expect(threadTitle('   ')).toBe('Conversa sem título')
  })
})

describe('page size and archived thread rule', () => {
  it('uses the default when missing or invalid and clamps to the max', () => {
    expect(pageSize(undefined, 50, 200)).toBe(50)
    expect(pageSize(0, 50, 200)).toBe(50)
    expect(pageSize(1.5, 50, 200)).toBe(50)
    expect(pageSize(500, 50, 200)).toBe(200)
    expect(pageSize(10, 30, 100)).toBe(10)
  })
  it('a proposal is archived only when its thread is not the current one', () => {
    expect(inArchivedThread({ thread_id: 'a' }, 'b')).toBe(true)
    expect(inArchivedThread({ thread_id: 'a' }, 'a')).toBe(false)
    expect(inArchivedThread({ thread_id: null }, 'a')).toBe(false)
  })
})

describe('CSV export', () => {
  it('has the columns data, hora, resumo, valor, status in pt-BR', () => {
    const [head, line] = actionsToCsv([row()]).split('\r\n')
    expect(head).toBe('data,hora,resumo,valor,status')
    expect(line).toBe('23/10/2026,12:30,Despesa lançada,"20,00",FEITO')
  })
  it('escapes quotes, commas and line breaks; blank value when there is no amount', () => {
    const csv = actionsToCsv([row({ summary: 'Disse "oi", depois\nsaiu', amount_cents: null, status: 'failed' })])
    expect(csv).toContain('"Disse ""oi"", depois\nsaiu",,FALHOU')
  })
  it('does not let a summary run as a spreadsheet formula', () => {
    expect(actionsToCsv([row({ summary: '=HYPERLINK("x")' })])).toContain("'=HYPERLINK")
  })
  it('uses São Paulo time for date and hour (01:30 UTC is still the previous evening)', () => {
    expect(actionsToCsv([row({ executed_at: '2026-10-24T01:30:00Z', status: 'undone' })])).toContain('23/10/2026,22:30')
  })
})

describe('log grouping by day', () => {
  it('groups by São Paulo day, newest first, keeping the order inside a day', () => {
    const g = groupActionsByDay([
      row({ summary: 'c', executed_at: '2026-10-24T02:00:00Z' }), // 23/10 23:00 in São Paulo
      row({ summary: 'b', executed_at: '2026-10-23T15:00:00Z' }),
      row({ summary: 'a', executed_at: '2026-10-22T15:00:00Z' }),
    ])
    expect(g.map((x) => x.day)).toEqual(['2026-10-23', '2026-10-22'])
    expect(g[0]!.items.map((i) => i.summary)).toEqual(['c', 'b'])
  })
  it('an empty list has no groups', () => {
    expect(groupActionsByDay([])).toEqual([])
  })
})

describe('Desfazer visibility', () => {
  it('only a done action with undo data still available', () => {
    expect(undoVisible({ status: 'done', undoable: true })).toBe(true)
    expect(undoVisible({ status: 'done', undoable: false })).toBe(false)
    expect(undoVisible({ status: 'undone', undoable: true })).toBe(false)
    expect(undoVisible({ status: 'failed', undoable: true })).toBe(false)
  })
})
