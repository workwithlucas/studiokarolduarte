import { afterEach, describe, expect, it, vi } from 'vitest'
import { ERROR_MESSAGES, RpcError, rpc, supabase, type ErrorCode } from './rpc'

const CODES: ErrorCode[] = [
  'SLOT_TAKEN',
  'OUTSIDE_HOURS',
  'BLOCKED',
  'NOTICE_TOO_SHORT',
  'TOO_FAR_AHEAD',
  'PRO_NOT_LINKED',
  'SERVICE_INACTIVE',
  'ACTION_INVALID',
  'BAD_TRANSITION',
  'PACKAGE_INVALID',
  'PACKAGE_EMPTY',
  'PACKAGE_EXPIRED',
  'HAS_USAGE',
  'BLOCK_CONFLICT',
  'NOT_FOUND',
  'FORBIDDEN',
  'INVALID_PHONE',
  'DUPLICATE_CLIENT',
]

afterEach(() => vi.restoreAllMocks())

describe('error mapping', () => {
  it('covers all 18 codes', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...CODES].sort())
    expect(CODES).toHaveLength(18)
  })

  it.each(CODES)('%s maps to its pt-BR message', async (code) => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: { message: code, details: 'detalhe', hint: '', code: 'P0001' } } as never)
    const err = await rpc.confirmAppointment({ p_appointment_id: 'x' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RpcError)
    expect((err as RpcError).code).toBe(code)
    expect((err as RpcError).message).toBe(ERROR_MESSAGES[code])
    expect((err as RpcError).detail).toBe('detalhe')
  })

  it('unknown errors fall back to the database detail', async () => {
    vi.spyOn(supabase, 'rpc').mockResolvedValue({ data: null, error: { message: 'boom', details: 'Falha', hint: '', code: 'X' } } as never)
    const err = (await rpc.confirmAppointment({ p_appointment_id: 'x' }).catch((e: unknown) => e)) as RpcError
    expect(err.code).toBe('UNKNOWN')
    expect(err.message).toBe('Falha')
  })
})
