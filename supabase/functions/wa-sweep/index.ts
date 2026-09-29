// Safety-net sweep, called every minute by pg_cron when there is something to do.
import { runSweep } from '../_shared/sweep.ts'
import { authorized, background, buildDeps, invokeAgentRun, json, serve } from '../_deno/runtime.ts'

serve((req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)
  if (!authorized(req)) return json({ error: 'unauthorized' }, 401)
  const deps = buildDeps()
  background(
    runSweep(deps, invokeAgentRun)
      .then((r) => deps.log('wa_sweep', { ...r }))
      .catch((e) => deps.log('wa_sweep_failed', { error: String(e instanceof Error ? e.message : e) })),
  )
  return json({ ok: true })
})
