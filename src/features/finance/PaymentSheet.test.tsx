// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SnackbarProvider } from '../../components/ui'
import { PaymentPanel, type PayTarget } from './PaymentSheet'

const mocks = vi.hoisted(() => {
  class MockRpcError extends Error {
    readonly code: string
    readonly detail: string | null
    constructor(code: string, message: string) {
      super(message)
      this.code = code
      this.detail = null
    }
  }
  return { eligible: vi.fn(), apply: vi.fn(), completeAndPay: vi.fn(), registerPayments: vi.fn(), MockRpcError }
})
const MockRpcError = mocks.MockRpcError

vi.mock('../../lib/rpc', () => ({
  RpcError: mocks.MockRpcError,
  messageOf: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  rpc: {
    eligiblePackages: mocks.eligible,
    applyPackageToAppointment: mocks.apply,
    completeAndPay: mocks.completeAndPay,
    registerPayments: mocks.registerPayments,
    clientAccountSummary: vi.fn(async () => []),
  },
  // package preview: 3 sessions in total, one already linked to an earlier appointment
  supabase: {
    from: (table: string) => {
      const result = table === 'appointments' ? { data: [{ starts_at: '2026-10-01T13:00:00Z' }], error: null } : { data: { sessions_total: 3 }, error: null }
      const q: any = { select: () => q, eq: () => q, in: () => q, maybeSingle: async () => result, then: (f: (r: unknown) => unknown) => Promise.resolve(result).then(f) }
      return q
    },
  },
}))

const two = [
  { client_package_id: 'pk-early', template_name: 'Sobrancelha x3', remaining: 2, expires_at: '2026-11-10' },
  { client_package_id: 'pk-late', template_name: 'Sobrancelha x3', remaining: 3, expires_at: '2026-12-10' },
]

function renderPanel(target: Partial<PayTarget> = {}, onDone = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const t: PayTarget = {
    mode: 'complete', appointmentId: 'a1', startsAt: '2026-10-20T13:00:00Z', day: '2026-10-20', clientId: null,
    title: 'Ana', detail: 'Sobrancelha · Colocação', grossCents: 10000, ...target,
  }
  render(
    <QueryClientProvider client={qc}>
      <SnackbarProvider>
        <PaymentPanel target={t} onDone={onDone} />
      </SnackbarProvider>
    </QueryClientProvider>,
  )
  return { onDone }
}

beforeEach(() => {
  mocks.eligible.mockReset()
  mocks.apply.mockReset()
  mocks.completeAndPay.mockReset()
  mocks.registerPayments.mockReset()
})
afterEach(cleanup)

describe('Payment sheet, package mode', () => {
  it('without eligible packages there is no package chip and the normal flow stays', async () => {
    mocks.eligible.mockResolvedValue([])
    renderPanel()
    await waitFor(() => expect(mocks.eligible).toHaveBeenCalledWith({ p_appointment_id: 'a1' }))
    expect(screen.queryByText(/PACOTE/)).toBeNull()
    expect(screen.getByLabelText('Desconto (R$)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Concluir e receber' })).toBeTruthy()
  })

  it('the FIRST chip is "PACOTE · X restantes"; selecting it hides discount and payment lines', async () => {
    mocks.eligible.mockResolvedValue([two[0]])
    renderPanel()
    const chip = await screen.findByRole('button', { name: 'PACOTE · 2 restantes' })
    const chips = Array.from(chip.parentElement!.querySelectorAll('button'))
    expect(chips[0]).toBe(chip)
    fireEvent.click(chip)
    expect(screen.queryByLabelText('Desconto (R$)')).toBeNull()
    expect(screen.queryByText('Total a receber')).toBeNull()
    expect(screen.queryByText('Dividir')).toBeNull()
    await waitFor(() => expect(screen.getByText('Usa 1 sessão do pacote · R$ 0,00 · sessão 2/3')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Concluir e usar pacote' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Concluir e receber' })).toBeNull()
  })

  it('complete mode: "Concluir e usar pacote" calls rpc_complete_and_pay with the package, no discount, no payments', async () => {
    mocks.eligible.mockResolvedValue([two[0]])
    mocks.completeAndPay.mockResolvedValue({ session_number: 2, sessions_total: 3, remaining: 1 })
    const { onDone } = renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'PACOTE · 2 restantes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Concluir e usar pacote' }))
    await waitFor(() => expect(mocks.completeAndPay).toHaveBeenCalledTimes(1))
    expect(mocks.completeAndPay.mock.calls[0]![0]).toMatchObject({
      p_appointment_id: 'a1', p_client_package_id: 'pk-early', p_discount_cents: null, p_payments: [],
    })
    expect(mocks.registerPayments).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Sessão 2/3 do pacote usada')).toBeTruthy())
    expect(onDone).toHaveBeenCalled()
  })

  it('pay mode: "Usar pacote" calls rpc_apply_package_to_appointment', async () => {
    mocks.eligible.mockResolvedValue([two[0]])
    mocks.apply.mockResolvedValue({ client_package_id: 'pk-early', session_number: 2, sessions_total: 3, remaining: 1 })
    renderPanel({ mode: 'pay', entryId: 'e1', day: undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'PACOTE · 2 restantes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Usar pacote' }))
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledWith({ p_appointment_id: 'a1', p_client_package_id: 'pk-early' }))
    expect(mocks.registerPayments).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByText('Sessão 2/3 do pacote usada')).toBeTruthy())
  })

  it('several packages: a select, the earliest expiry by default; the choice is what gets applied', async () => {
    mocks.eligible.mockResolvedValue(two)
    mocks.apply.mockResolvedValue({ client_package_id: 'pk-late', session_number: 2, sessions_total: 3, remaining: 2 })
    renderPanel({ mode: 'pay', entryId: 'e1', day: undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'PACOTE · 2 restantes' }))
    const select = (await screen.findByLabelText('Pacote')) as HTMLSelectElement
    expect(select.value).toBe('pk-early')
    fireEvent.change(select, { target: { value: 'pk-late' } })
    expect(screen.getByRole('button', { name: 'PACOTE · 3 restantes' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Usar pacote' }))
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledWith({ p_appointment_id: 'a1', p_client_package_id: 'pk-late' }))
  })

  it('HAS_PAYMENTS shows its message plus the hint to reverse the payment in the Extrato', async () => {
    mocks.eligible.mockResolvedValue([two[0]])
    mocks.apply.mockRejectedValue(new MockRpcError('HAS_PAYMENTS', 'Existem pagamentos registrados; estorne-os primeiro.'))
    renderPanel({ mode: 'pay', entryId: 'e1', day: undefined })
    fireEvent.click(await screen.findByRole('button', { name: 'PACOTE · 2 restantes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Usar pacote' }))
    await waitFor(() => expect(screen.getByText(/Existem pagamentos registrados; estorne-os primeiro\./)).toBeTruthy())
    expect(screen.getByText(/Estorne o pagamento no Extrato antes de usar o pacote/)).toBeTruthy()
  })

  it('selecting a payment method again leaves the package mode', async () => {
    mocks.eligible.mockResolvedValue([two[0]])
    renderPanel()
    fireEvent.click(await screen.findByRole('button', { name: 'PACOTE · 2 restantes' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pix' }))
    expect(screen.getByLabelText('Desconto (R$)')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Concluir e receber' })).toBeTruthy()
  })

  it('an expense or an appointment already at R$ 0,00 never asks for packages', async () => {
    mocks.eligible.mockResolvedValue([two[0]])
    renderPanel({ kind: 'expense', appointmentId: undefined })
    renderPanel({ grossCents: 0 })
    await new Promise((r) => setTimeout(r, 30))
    expect(mocks.eligible).not.toHaveBeenCalled()
    expect(screen.queryByText(/PACOTE/)).toBeNull()
  })
})
