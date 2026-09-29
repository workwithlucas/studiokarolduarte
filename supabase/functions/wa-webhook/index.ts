// Z-API received-message webhook. POST only, secret in ?s=, 200 immediately, work in the background.
import { safeEqual } from '../_shared/security.ts'
import { handleReceived } from '../_shared/webhook.ts'
import { background, buildDeps, invokeAgentRun, secret, serve } from '../_deno/runtime.ts'

serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!safeEqual(new URL(req.url).searchParams.get('s'), secret('WEBHOOK_SECRET'))) return new Response('unauthorized', { status: 401 })
  const raw = await req.text()
  const deps = buildDeps()
  background(
    handleReceived(deps, raw, invokeAgentRun).catch((e) => deps.log('wa_webhook_failed', { error: String(e instanceof Error ? e.message : e) })),
  )
  return new Response('ok', { status: 200 })
})
