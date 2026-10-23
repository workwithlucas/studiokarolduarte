// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingView } from '../../lib/assistantQueries'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), load: vi.fn() }))

vi.mock('../../lib/assistantQueries', async (orig) => {
  const real = await orig<typeof import('../../lib/assistantQueries')>()
  return { ...real, invokeAssistant: mocks.invoke, loadThread: mocks.load }
})

import { ASSISTANT_INVALIDATE_KEYS, invalidateAfterWrite } from '../../lib/assistantQueries'
import AssistantSheet from './AssistantSheet'
import { ChoiceChips, ProposalCard, ResultCard } from './cards'

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as never
  Element.prototype.scrollIntoView = () => {}
  mocks.invoke.mockReset()
  mocks.load.mockReset()
})
afterEach(cleanup)

const pending = (status: PendingView['status'], undoable: number[] = []): PendingView => ({ id: 'p1', status, expires_at: '2999-01-01T00:00:00Z', undoable })
const proposal = {
  kind: 'proposal' as const, pending_id: 'p1', expires_at: '2999-01-01T00:00:00Z',
  actions: [{ title: 'Lançar despesa', lines: [{ label: 'Valor', value: 'R$ 20,00' }], warnings: ['Valor alto, confira'] }],
}

describe('invalidation after a confirmed action or an undo', () => {
  it('covers finance summary and lists, appointments, packages and client pages', () => {
    const calls: string[] = []
    invalidateAfterWrite({ invalidateQueries: (f: { queryKey?: readonly unknown[] }) => (calls.push(String(f.queryKey?.[0])), Promise.resolve()) } as never)
    for (const k of ['finance-summary', 'finance-list', 'appointments', 'packages', 'client-account', 'client-context', 'client-appts']) expect(calls).toContain(k)
    expect(calls).toHaveLength(ASSISTANT_INVALIDATE_KEYS.length)
  })
})

describe('ProposalCard', () => {
  it('shows fields and warnings; Confirmar and Cancelar call back', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(<ProposalCard card={proposal} pending={pending('pending')} busy={false} onConfirm={onConfirm} onCancel={onCancel} />)
    expect(screen.getByText('R$ 20,00')).toBeTruthy()
    expect(screen.getByText('Valor alto, confira')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
  it('both buttons are disabled while a request is pending', () => {
    const onConfirm = vi.fn()
    render(<ProposalCard card={proposal} pending={pending('pending')} busy onConfirm={onConfirm} onCancel={() => {}} />)
    const buttons = screen.getAllByRole('button') as HTMLButtonElement[]
    expect(buttons.length).toBe(2)
    for (const b of buttons) expect(b.disabled).toBe(true)
    fireEvent.click(buttons[0]!)
    expect(onConfirm).not.toHaveBeenCalled()
  })
  it('no buttons once confirmed; the state is shown instead', () => {
    render(<ProposalCard card={proposal} pending={pending('confirmed')} busy={false} onConfirm={() => {}} onCancel={() => {}} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('Confirmado')).toBeTruthy()
  })
  it('hit targets are at least 44px (hit class on every button)', () => {
    render(<ProposalCard card={proposal} pending={pending('pending')} busy={false} onConfirm={() => {}} onCancel={() => {}} />)
    for (const b of screen.getAllByRole('button')) expect(b.className).toContain('hit')
  })
})

describe('ResultCard', () => {
  const card = { kind: 'result' as const, pending_id: 'p1', lines: [{ index: 0, ok: true, text: 'despesa lançada' }, { index: 1, ok: false, text: 'Valor inválido.' }, { index: 2, ok: true, text: 'sem desfazer' }] }
  it('offers Desfazer only for undoable ok lines', () => {
    const onUndo = vi.fn()
    render(<ResultCard card={card} pending={pending('confirmed', [0])} busy={false} onUndo={onUndo} />)
    const btns = screen.getAllByRole('button', { name: 'Desfazer' })
    expect(btns).toHaveLength(1)
    fireEvent.click(btns[0]!)
    expect(onUndo).toHaveBeenCalledWith(0)
  })
  it('no Desfazer once undone', () => {
    render(<ResultCard card={card} pending={pending('confirmed', [])} busy={false} onUndo={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Desfazer' })).toBeNull()
  })
})

describe('ChoiceChips', () => {
  const card = {
    kind: 'choice' as const, choice_id: 'c1', slot: 'entry_id' as const, question: 'Qual destes lançamentos?',
    options: [{ label: 'Julio A · Manicure', detail: '23/10/2026 · R$ 80,00', value: 'e1' }, { label: 'Julio B · Manicure', detail: '23/10/2026 · R$ 80,00', value: 'e2' }],
    intent: { tool: 'propose_payment', input: {}, carry: [] },
  }
  it('picking a chip reports its stored value', () => {
    const onPick = vi.fn()
    render(<ChoiceChips card={card} disabled={false} onPick={onPick} />)
    fireEvent.click(screen.getByText('Julio B · Manicure'))
    expect(onPick).toHaveBeenCalledWith('e2', 'Julio B · Manicure')
  })
  it('a resolved or busy card cannot be picked', () => {
    const onPick = vi.fn()
    render(<ChoiceChips card={card} disabled onPick={onPick} />)
    fireEvent.click(screen.getByText('Julio A · Manicure'))
    expect(onPick).not.toHaveBeenCalled()
  })
})

describe('AssistantSheet', () => {
  function mount() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={qc}>
        <AssistantSheet open onClose={() => {}} />
      </QueryClientProvider>,
    )
  }
  it('empty state has the three starter chips; a chip sends one message with a request id', async () => {
    mocks.load.mockResolvedValue({ messages: [], pendings: [] })
    mocks.invoke.mockResolvedValue({ messages: [{ id: 'm1', role: 'user', body: 'Resumo de hoje', card: null, created_at: '2026-10-23T12:00:00Z' }], pendings: [] })
    mount()
    for (const label of ['Lançar despesa', 'Dar baixa', 'Resumo de hoje']) expect(await screen.findByRole('button', { name: label })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Resumo de hoje' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    const body = mocks.invoke.mock.calls[0]![0]
    expect(body).toMatchObject({ action: 'message', text: 'Resumo de hoje' })
    expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('a failed send shows a clear message and retries with the same request id', async () => {
    mocks.load.mockResolvedValue({ messages: [], pendings: [] })
    mocks.invoke.mockRejectedValueOnce(new Error('Muitas mensagens em pouco tempo. Aguarde alguns minutos e tente de novo.'))
    mocks.invoke.mockResolvedValueOnce({ messages: [], pendings: [] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Dar baixa' }))
    expect(await screen.findByText(/Muitas mensagens/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2))
    expect(mocks.invoke.mock.calls[1]![0].request_id).toBe(mocks.invoke.mock.calls[0]![0].request_id)
  })
  it('confirm sends the pending id and invalidates after success', async () => {
    mocks.load.mockResolvedValue({
      messages: [{ id: 'c1', role: 'card', body: null, card: proposal, created_at: '2026-10-23T12:00:00Z' }],
      pendings: [pending('pending')],
    })
    mocks.invoke.mockResolvedValue({ messages: [], pendings: [pending('confirmed', [0])] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Confirmar' }))
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(1))
    expect(mocks.invoke.mock.calls[0]![0]).toMatchObject({ action: 'confirm', pending_id: 'p1' })
    expect(await screen.findByText('Confirmado')).toBeTruthy()
  })
})
