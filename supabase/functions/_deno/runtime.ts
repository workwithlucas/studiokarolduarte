// Deno wiring for the Edge Functions: real db client, fetch, clock and secrets (Deno.env only).
// Not imported by tests. Logic lives in ../_shared/*.ts.
import { createClient } from 'npm:@supabase/supabase-js@2'
import { safeEqual } from '../_shared/security.ts'
import type { AssistantRuntime } from '../_shared/assistant.ts'
import type { Db, Deps } from '../_shared/types.ts'

declare const Deno: { env: { get(k: string): string | undefined }; serve: (h: (req: Request) => Response | Promise<Response>) => void }
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void }

const env = (k: string) => Deno.env.get(k)

export function buildDeps(): Deps {
  const db = createClient(env('SUPABASE_URL') ?? '', env('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } })
  return {
    db: db as unknown as Db,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    random: Math.random,
    cfg: {
      anthropicKey: env('ANTHROPIC_API_KEY'),
      groqKey: env('GROQ_API_KEY'),
      model: env('THAIS_MODEL') || 'claude-haiku-4-5-20251001',
      zapi: { instanceId: env('ZAPI_INSTANCE_ID') ?? '', token: env('ZAPI_TOKEN') ?? '', clientToken: env('ZAPI_CLIENT_TOKEN') ?? '' },
      legacyUrl: env('LEGACY_WEBHOOK_URL') || undefined,
    },
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  }
}

/** CRON_SECRET header (pg_cron / internal calls) or the service_role key as bearer token. */
export function authorized(req: Request): boolean {
  const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  return safeEqual(req.headers.get('x-cron-secret'), env('CRON_SECRET')) || safeEqual(bearer, env('SUPABASE_SERVICE_ROLE_KEY'))
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function background(p: Promise<unknown>): void {
  EdgeRuntime.waitUntil(p)
}

export function serve(handler: (req: Request) => Response | Promise<Response>): void {
  Deno.serve(handler)
}

export function secret(name: string): string | undefined {
  return env(name)
}

/** Calls the agent-run function for a conversation (own invocation, own time budget). */
export async function invokeAgentRun(conversationId: string): Promise<void> {
  const res = await fetch(`${env('SUPABASE_URL')}/functions/v1/agent-run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-secret': env('CRON_SECRET') ?? '' },
    body: JSON.stringify({ conversation_id: conversationId }),
  })
  if (!res.ok) throw new Error(`agent-run HTTP ${res.status}`)
}

/** The finance assistant: service client for its own tables, JWT-scoped client for the finance RPCs. */
export function buildAssistantRuntime(): AssistantRuntime {
  const url = env('SUPABASE_URL') ?? ''
  const svc = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY') ?? '', { auth: { persistSession: false } })
  return {
    svc: svc as unknown as Db,
    authenticate: async (jwt) => {
      const { data, error } = await svc.auth.getUser(jwt)
      return error || !data.user ? null : { id: data.user.id }
    },
    userDb: (jwt) =>
      createClient(url, env('SUPABASE_ANON_KEY') ?? '', {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      }) as unknown as Db,
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    cfg: { anthropicKey: env('ANTHROPIC_API_KEY'), model: env('ASSISTANT_MODEL') || 'claude-haiku-4-5-20251001' },
    log: (event, data) => console.log(JSON.stringify({ event, ...data })),
  }
}
