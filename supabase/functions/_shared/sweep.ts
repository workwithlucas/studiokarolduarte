// wa-sweep: safety net for conversations whose webhook run was skipped or failed.
import { callRpc, loadSettings, modeRuns, unwrap } from './db.ts'
import { awayDue } from './gates.ts'
import { inWindow, isoOf } from './time.ts'
import type { Deps } from './types.ts'

export interface SweepResult {
  returned: number
  invoked: number
  flagged: number
}

export async function runSweep(deps: Deps, invokeRun: (conversationId: string) => Promise<void>): Promise<SweepResult> {
  const { db } = deps
  const now = deps.now()
  const nowIso = isoOf(now)

  // Human hold over: back to the agent. Old pending messages are cleared so stale text is not answered.
  const back = unwrap<Array<{ id: string }>>(
    await db.from('wa_conversations').update({ mode: 'agent', human_until: null, pending_since: null }).eq('mode', 'human').lt('human_until', nowIso).select('id'),
  )

  const settings = await loadSettings(db)
  if (settings.agent_mode === 'off') return { returned: (back ?? []).length, invoked: 0, flagged: 0 }

  // Three failed runs in a row: stop retrying and ask for a human.
  const broken = unwrap<Array<{ id: string }>>(
    await db.from('wa_conversations').select('id').gte('failed_runs', 3).not('pending_since', 'is', null).eq('needs_attention', false),
  )
  for (const c of broken ?? []) {
    // the real error (stored by the failed run), never a generic message
    const last = unwrap<Array<{ error_text: string | null }>>(
      await db.from('agent_decisions').select('error_text').eq('conversation_id', c.id).eq('action', 'error').order('decided_at', { ascending: false }).limit(1),
    )
    const why = last?.[0]?.error_text?.trim()
    await callRpc(db, 'agent_flag', { p_conversation_id: c.id, p_reason: why ? `Erro do agente: ${why}` : 'Erro do agente', p_handoff: false })
  }

  const cutoff = isoOf(now - 60_000)
  const rows = unwrap<Array<{ id: string; phone_e164: string; away_sent_at: string | null }>>(
    await db.from('wa_conversations').select('id,phone_e164,away_sent_at')
      .not('pending_since', 'is', null).eq('mode', 'agent').lt('failed_runs', 3).lt('last_inbound_at', cutoff)
      .or(`lease_until.is.null,lease_until.lt.${nowIso}`).limit(20),
  )
  const open = inWindow(now, settings.agent_window_start, settings.agent_window_end)
  const eligible = (rows ?? []).filter((r) => modeRuns(settings, r.phone_e164) && (open || awayDue(r.away_sent_at, now)))
  const results = await Promise.allSettled(eligible.map((r) => invokeRun(r.id)))
  for (const r of results) if (r.status === 'rejected') deps.log('sweep_invoke_failed', { error: String(r.reason) })
  return { returned: (back ?? []).length, invoked: eligible.length, flagged: (broken ?? []).length }
}
