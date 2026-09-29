import { describe, expect, it } from 'vitest'
import { actionLabel, formatPhoneBR, statusLabel, toTitlePt } from './format'

describe('toTitlePt', () => {
  it('capitalizes words and lowercases connectors', () => {
    expect(toTitlePt('DESIGN DE SOBRANCELHA COM HENA')).toBe('Design de Sobrancelha com Hena')
    expect(toTitlePt('maria das dores e silva')).toBe('Maria das Dores e Silva')
    expect(toTitlePt('alongamento em gel para unhas')).toBe('Alongamento em Gel para Unhas')
  })
  it('keeps a connector capitalized as the first word', () => {
    expect(toTitlePt('de luxo')).toBe('De Luxo')
    expect(toTitlePt('a bela')).toBe('A Bela')
  })
  it('handles empty input', () => {
    expect(toTitlePt('')).toBe('')
    expect(toTitlePt(null)).toBe('')
    expect(toTitlePt('  espaços   extras ')).toBe('Espaços Extras')
  })
})

describe('labels', () => {
  it('formats phones', () => {
    expect(formatPhoneBR('5511988880001')).toBe('(11) 98888-0001')
    expect(formatPhoneBR('551138880001')).toBe('(11) 3888-0001')
    expect(formatPhoneBR(null)).toBe('—')
  })
  it('action and status labels', () => {
    expect(actionLabel('placement')).toBe('Colocação')
    expect(actionLabel('maintenance')).toBe('Manutenção')
    expect(actionLabel('removal')).toBe('Remoção')
    expect(statusLabel('confirmed')).toBe('Confirmado')
    expect(statusLabel('nope')).toBe('—')
  })
})
