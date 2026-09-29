// Sends tomorrow's confirmation messages. Called every 15 minutes by pg_cron.
import { runConfirmations } from '../_shared/confirmations.ts'
import { authorized, background, buildDeps, json, serve } from '../_deno/runtime.ts'

serve((req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401)
  const deps = buildDeps()
  background(
    runConfirmations(deps)
      .then((r) => deps.log('send_confirmations', { ...r }))
      .catch((e) => deps.log('send_confirmations_failed', { error: String(e instanceof Error ? e.message : e) })),
  )
  return json({ ok: true })
})
