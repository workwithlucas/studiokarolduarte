import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync('public/manifest.webmanifest', 'utf8')) as Record<string, unknown> & {
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>
}

describe('manifest', () => {
  it('has the required fields', () => {
    expect(manifest).toMatchObject({
      name: 'Studio Karol Duarte',
      short_name: 'Studio KD',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      orientation: 'any',
      lang: 'pt-BR',
      background_color: '#FBF1EC',
      theme_color: '#5A2138',
    })
  })

  it('lists 192, 512 and maskable 512 icons that exist on disk', () => {
    const by = (sizes: string, purpose?: string) => manifest.icons.find((i) => i.sizes === sizes && i.purpose === purpose)
    expect(by('192x192')?.src).toBe('/icons/icon-192.png')
    expect(by('512x512')?.src).toBe('/icons/icon-512.png')
    expect(by('512x512', 'maskable')?.src).toBe('/icons/icon-maskable-512.png')
    for (const i of manifest.icons) expect(existsSync(`public${i.src}`), i.src).toBe(true)
    expect(existsSync('public/icons/apple-touch-icon.png')).toBe(true)
    expect(existsSync('public/icons/favicon.svg')).toBe(true)
  })
})

describe('index.html', () => {
  const html = readFileSync('index.html', 'utf8')
  it.each([
    'rel="manifest" href="/manifest.webmanifest"',
    'name="theme-color"',
    'rel="apple-touch-icon"',
    'name="apple-mobile-web-app-capable"',
    'name="apple-mobile-web-app-title"',
    'name="apple-mobile-web-app-status-bar-style"',
    'viewport-fit=cover',
    '<title>Studio Karol Duarte</title>',
  ])('contains %s', (needle) => expect(html).toContain(needle))
})

describe('deploy and no-offline rules', () => {
  it('vercel.json rewrites every route to /index.html', () => {
    const v = JSON.parse(readFileSync('vercel.json', 'utf8')) as { rewrites: Array<{ source: string; destination: string }> }
    expect(v.rewrites).toContainEqual({ source: '/(.*)', destination: '/index.html' })
  })

  it('ships no service worker and never registers one', () => {
    expect(readdirSync('public').filter((f) => /sw|service-?worker/i.test(f))).toEqual([])
    expect(readFileSync('src/main.tsx', 'utf8')).not.toMatch(/serviceWorker|caches\./)
  })
})
