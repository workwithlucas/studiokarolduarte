// Owner-only finance assistant. The project deploys with --no-verify-jwt: the JWT is verified inside (handleAssistant).
import { handleAssistant } from '../_shared/assistant.ts'
import { buildAssistantRuntime, json, serve } from '../_deno/runtime.ts'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Método não permitido.' }, 405, CORS)
  const jwt = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '') || null
  const body = await req.json().catch(() => null)
  const reply = await handleAssistant(buildAssistantRuntime(), jwt, body)
  return json(reply.body, reply.status, CORS)
})
