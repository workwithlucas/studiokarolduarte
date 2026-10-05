// Fixed WhatsApp notice after a time adjustment. The text is built server-side from stored data (no AI call);
// the app only names the reschedule request. A failure here never undoes the adjustment.
import { supabase } from './supabase'

export type NoticeOutcome = 'sent' | 'no_phone' | 'not_pending' | 'mode_off' | 'invalid' | 'failed'

export const NOTICE_MESSAGES: Record<NoticeOutcome, string | null> = {
  sent: 'Cliente avisada',
  no_phone: 'Cliente sem telefone: aviso não enviado',
  not_pending: null,
  mode_off: 'WhatsApp desligado: aviso não enviado',
  invalid: 'Aviso não enviado',
  failed: 'Não foi possível avisar a cliente',
}

export async function notifyReschedule(requestId: string): Promise<NoticeOutcome> {
  try {
    const { data, error } = await supabase.functions.invoke('notify-reschedule', { body: { request_id: requestId } })
    if (error) return 'failed'
    const outcome = (data as { outcome?: unknown } | null)?.outcome
    return typeof outcome === 'string' && outcome in NOTICE_MESSAGES ? (outcome as NoticeOutcome) : 'failed'
  } catch {
    return 'failed'
  }
}
