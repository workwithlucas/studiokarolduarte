// Production smoke test: unauthenticated requests only. Base URL from the environment (process env only, no files, no keys).
//   $env:PROD_BASE_URL = "https://SEU_PROJECT_REF.supabase.co"; npm run smoke:prod
export {}

const base = (process.env.PROD_BASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
if (!/^https:\/\/[^/\s]+$/.test(base)) {
  console.log('smoke:prod FAIL: set PROD_BASE_URL (https://SEU_PROJECT_REF.supabase.co) in this PowerShell window.')
  process.exit(1)
}

let failed = 0
async function expect401(name: string, url: string) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20_000) })
    const ok = res.status === 401
    if (!ok) failed++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} -> ${res.status} (esperado 401)`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name} -> ${e instanceof Error ? e.message : String(e)}`)
  }
}

await expect401('wa-webhook com s errado', `${base}/functions/v1/wa-webhook?s=wrong`)
await expect401('agent-run sem segredo', `${base}/functions/v1/agent-run`)
console.log(`smoke:prod ${failed === 0 ? 'PASS' : 'FAIL'} (${failed} falhas)`)
process.exit(failed === 0 ? 0 : 1)
