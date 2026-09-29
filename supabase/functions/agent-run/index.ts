// One agent turn for a conversation. Auth: CRON_SECRET header or service_role bearer.
import { runAgent } from '../_shared/agent.ts'
import { isUuid } from '../_shared/gates.ts'
import { authorized, buildDeps, json, serve } from '../_deno/runtime.ts'

serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401)
  const body = (await req.json().catch(() => null)) as { conversation_id?: unknown } | null
  if (!isUuid(body?.conversation_id)) return json({ error: 'conversation_id invalid' }, 400)
  const deps = buildDeps()
  const outcome = await runAgent(deps, body.conversation_id)
  deps.log('agent_run', { conversation: body.conversation_id, status: outcome.status, reason: outcome.reason })
  return json({ status: outcome.status })
})
