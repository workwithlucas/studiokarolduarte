// Typed wrapper around every rpc_*. The UI and the agent call the same functions.
// Rule violations come back as error.message = code, error.details = pt-BR text.
import type { Database } from '../types/db'
import { supabase } from './supabase'

export { supabase }

export const ERROR_MESSAGES = {
  SLOT_TAKEN: 'Este horário já está ocupado.',
  OUTSIDE_HOURS: 'Horário fora do expediente da profissional.',
  BLOCKED: 'Este horário está bloqueado na agenda.',
  NOTICE_TOO_SHORT: 'Antecedência mínima não respeitada.',
  TOO_FAR_AHEAD: 'Data além do limite de agendamento antecipado.',
  PRO_NOT_LINKED: 'Esta profissional não realiza este serviço.',
  SERVICE_INACTIVE: 'Este serviço está inativo.',
  ACTION_INVALID: 'Ação inválida para este serviço.',
  BAD_TRANSITION: 'Operação não permitida no estado atual.',
  PACKAGE_INVALID: 'Pacote inválido para este cliente ou serviço.',
  PACKAGE_EMPTY: 'Este pacote não tem mais sessões.',
  PACKAGE_EXPIRED: 'Este pacote está vencido para a data escolhida.',
  HAS_USAGE: 'Existem agendamentos vinculados; cancele-os primeiro.',
  BLOCK_CONFLICT: 'Há agendamentos dentro do período bloqueado.',
  NOT_FOUND: 'Registro não encontrado.',
  FORBIDDEN: 'Você não tem permissão para esta ação.',
} as const

export type ErrorCode = keyof typeof ERROR_MESSAGES

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && x in ERROR_MESSAGES
}

export class RpcError extends Error {
  readonly code: ErrorCode | 'UNKNOWN'
  /** Extra pt-BR detail from the database (e.g. the list of conflicting appointments). */
  readonly detail: string | null

  constructor(code: ErrorCode | 'UNKNOWN', message: string, detail: string | null) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.detail = detail
  }
}

type Fns = Database['public']['Functions']
type RpcName = Extract<keyof Fns, `rpc_${string}`>

// Nullable parameters are typed non-null by the generator; the database accepts NULL for them.
type Nullable<A> = { [K in keyof A]: A[K] | null }
type Args<K extends RpcName> = Nullable<Fns[K]['Args']>
type Ret<K extends RpcName> = Fns[K]['Returns']

async function call<K extends RpcName>(name: K, args: Args<K>): Promise<Ret<K>> {
  const { data, error } = await supabase.rpc(name, args as never)
  if (error) {
    const code = isErrorCode(error.message) ? error.message : 'UNKNOWN'
    const message = code === 'UNKNOWN' ? (error.details || error.message) : ERROR_MESSAGES[code]
    throw new RpcError(code, message, error.details || null)
  }
  return data as Ret<K>
}

export const rpc = {
  // catalog (owner)
  upsertService: (a: Args<'rpc_upsert_service'>) => call('rpc_upsert_service', a),
  upsertAddon: (a: Args<'rpc_upsert_addon'>) => call('rpc_upsert_addon', a),
  setProfessionalServices: (a: Args<'rpc_set_professional_services'>) => call('rpc_set_professional_services', a),
  upsertProfessional: (a: Args<'rpc_upsert_professional'>) => call('rpc_upsert_professional', a),
  setWorkingHours: (a: Args<'rpc_set_working_hours'>) => call('rpc_set_working_hours', a),
  upsertPackageTemplate: (a: Args<'rpc_upsert_package_template'>) => call('rpc_upsert_package_template', a),
  // clients and packages (staff)
  upsertClient: (a: Args<'rpc_upsert_client'>) => call('rpc_upsert_client', a),
  findClientByPhone: (a: Args<'rpc_find_client_by_phone'>) => call('rpc_find_client_by_phone', a),
  getClientContext: (a: Args<'rpc_get_client_context'>) => call('rpc_get_client_context', a),
  sellPackage: (a: Args<'rpc_sell_package'>) => call('rpc_sell_package', a),
  voidPackage: (a: Args<'rpc_void_package'>) => call('rpc_void_package', a),
  // agenda (staff / agent)
  suggestProfessionals: (a: Args<'rpc_suggest_professionals'>) => call('rpc_suggest_professionals', a),
  getAvailability: (a: Args<'rpc_get_availability'>) => call('rpc_get_availability', a),
  bookAppointment: (a: Args<'rpc_book_appointment'>) => call('rpc_book_appointment', a),
  confirmAppointment: (a: Args<'rpc_confirm_appointment'>) => call('rpc_confirm_appointment', a),
  rescheduleAppointment: (a: Args<'rpc_reschedule_appointment'>) => call('rpc_reschedule_appointment', a),
  cancelAppointment: (a: Args<'rpc_cancel_appointment'>) => call('rpc_cancel_appointment', a),
  markNoShow: (a: Args<'rpc_mark_no_show'>) => call('rpc_mark_no_show', a),
  completeAppointment: (a: Args<'rpc_complete_appointment'>) => call('rpc_complete_appointment', a),
  createBlock: (a: Args<'rpc_create_block'>) => call('rpc_create_block', a),
  deleteBlock: (a: Args<'rpc_delete_block'>) => call('rpc_delete_block', a),
} as const

/** pt-BR message for any thrown value (RpcError carries the mapped text). */
export function messageOf(e: unknown): string {
  if (e instanceof RpcError) return e.message
  if (e instanceof Error) return e.message
  return 'Algo deu errado. Tente novamente.'
}
