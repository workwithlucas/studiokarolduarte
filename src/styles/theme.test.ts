import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const tokens = readFileSync('src/styles/tokens.css', 'utf8')

function token(name: string): string {
  const m = new RegExp(String.raw`--${name}:\s*(#[0-9A-Fa-f]{6})\s*;`).exec(tokens)
  if (!m) throw new Error(`token --${name} missing`)
  return m[1]!
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

describe('contrast', () => {
  it('ink on bg >= 7', () => expect(contrast(token('ink'), token('bg'))).toBeGreaterThanOrEqual(7))
  it('muted on surface >= 4.5', () => expect(contrast(token('muted'), token('surface'))).toBeGreaterThanOrEqual(4.5))
  it('gold on surface >= 3', () => expect(contrast(token('gold'), token('surface'))).toBeGreaterThanOrEqual(3))
  it('primary-ink on primary-bg >= 7', () => expect(contrast(token('primary-ink'), token('primary-bg'))).toBeGreaterThanOrEqual(7))
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('prof-%i on surface >= 3', (n) => {
    expect(contrast(token(`prof-${n}`), token('surface'))).toBeGreaterThanOrEqual(3)
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('no colour literals outside tokens.css', () => {
  const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/
  const files = walk('src').filter((f) => /\.(tsx?|css)$/.test(f) && !/tokens\.css$|theme\.test\.ts$/.test(f))
  it('scans files', () => expect(files.length).toBeGreaterThan(10))
  it('finds none', () => {
    const bad = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((l, i) => (literal.test(l) ? `${f}:${i + 1}` : ''))
        .filter(Boolean),
    )
    expect(bad).toEqual([])
  })
})
