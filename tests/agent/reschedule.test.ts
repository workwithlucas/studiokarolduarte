import { describe, expect, it } from 'vitest'
import { rescheduleText } from '../../supabase/functions/_shared/reschedule.ts'

describe('reschedule notice text', () => {
  it('uses the fixed text with first name, DD/MM and HH:MM in São Paulo time', () => {
    // 2026-10-06 18:00Z = 15:00 São Paulo
    expect(rescheduleText('ana maria souza', '2026-10-06T18:00:00Z')).toBe(
      'Olá, Ana! Seu horário no Studio Karol Duarte foi alterado para 06/10 às 15:00.',
    )
  })

  it('drops the name when empty and refuses an invalid start', () => {
    expect(rescheduleText('', '2026-10-06T18:00:00Z')).toBe('Olá! Seu horário no Studio Karol Duarte foi alterado para 06/10 às 15:00.')
    expect(rescheduleText('Ana', 'not a date')).toBeNull()
    expect(rescheduleText('Ana', null)).toBeNull()
  })
})
