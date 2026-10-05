// Typed wrapper around every rpc_*. The UI and the agent call the same functions.
// Rule violations come back as error.message = code, error.details = pt-BR text.
import type { Database } from '../types/db'
import type { ClientAccount, FinanceEntry, FinanceSummary, PaymentResult, SettleAllocation } from './finance'
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
  INVALID_PHONE: 'Telefone inválido. Use DDD + número.',
  DUPLICATE_CLIENT: 'Já existe uma cliente com este nome e telefone.',
  INVALID_SETTING: 'Configuração inválida. Confira os valores e tente de novo.',
  OVERPAYMENT: 'O valor recebido é maior que o saldo em aberto.',
  BAD_DISCOUNT: 'Desconto inválido para este lançamento.',
  BAD_AMOUNT: 'Valor inválido.',
  HAS_PAYMENTS: 'Existem pagamentos registrados; estorne-os primeiro.',
  CREDIT_INSUFFICIENT: 'O crédito da cliente não cobre este valor.',
  CREDIT_IN_USE: 'Este crédito já foi usado; estorne os usos primeiro.',
  METHOD_NOT_ALLOWED: 'Forma de pagamento não permitida aqui.',
  RANGE_TOO_LARGE: 'O período não pode passar de 366 dias.',
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
  searchClients: (a: Args<'rpc_search_clients'>) => call('rpc_search_clients', a),
  clientSpend: (a: Args<'rpc_client_spend'>) => call('rpc_client_spend', a),
  updateClient: (a: Args<'rpc_update_client'>) => call('rpc_update_client', a),
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
  adjustAppointmentTime: (a: Args<'rpc_adjust_appointment_time'>) => call('rpc_adjust_appointment_time', a),
  getFreeGap: (a: Args<'rpc_get_free_gap'>) => call('rpc_get_free_gap', a),
  createBlock: (a: Args<'rpc_create_block'>) => call('rpc_create_block', a),
  deleteBlock: (a: Args<'rpc_delete_block'>) => call('rpc_delete_block', a),
  // finance (professional: own totals only)
  myFinanceSummary: async (a: Args<'rpc_my_finance_summary'>) => (await call('rpc_my_finance_summary', a))[0] ?? { gross_cents: 0, studio_share_cents: 0 },
  // finance (owner only)
  registerPayments: async (a: Args<'rpc_register_payments'>) => (await call('rpc_register_payments', a)) as unknown as PaymentResult,
  completeAndPay: async (a: Args<'rpc_complete_and_pay'>) => (await call('rpc_complete_and_pay', a)) as unknown as PaymentResult,
  reversePayment: (a: Args<'rpc_reverse_payment'>) => call('rpc_reverse_payment', a),
  createManualEntry: (a: Args<'rpc_create_manual_entry'>) => call('rpc_create_manual_entry', a),
  editEntry: (a: Args<'rpc_edit_entry'>) => call('rpc_edit_entry', a),
  voidEntry: (a: Args<'rpc_void_entry'>) => call('rpc_void_entry', a),
  setCommissionRule: (a: Args<'rpc_set_commission_rule'>) => call('rpc_set_commission_rule', a),
  financeEntry: async (a: Args<'rpc_finance_entry'>) => (await call('rpc_finance_entry', a)) as unknown as FinanceEntry | null,
  financeImportKeys: (a: Args<'rpc_finance_import_keys'>) => call('rpc_finance_import_keys', a),
  financeSummary: async (a: Args<'rpc_finance_summary'>) => (await call('rpc_finance_summary', a)) as unknown as FinanceSummary,
  financeList: (a: Args<'rpc_finance_list'>) => call('rpc_finance_list', a),
  // client account (owner only)
  addClientCredit: (a: Args<'rpc_add_client_credit'>) => call('rpc_add_client_credit', a),
  settleClientAccount: async (a: Args<'rpc_settle_client_account'>) => (await call('rpc_settle_client_account', a)) as unknown as SettleAllocation[],
  getClientAccount: async (a: Args<'rpc_get_client_account'>) => (await call('rpc_get_client_account', a)) as unknown as ClientAccount,
  clientAccountSummary: (a: Args<'rpc_client_account_summary'>) => call('rpc_client_account_summary', a),
  // agent (owner only)
  agentOverview: () => call('rpc_agent_overview', undefined as never),
  agentSetSettings: (a: Args<'rpc_agent_set_settings'>) => call('rpc_agent_set_settings', a),
  agentReturnConversation: (a: Args<'rpc_agent_return_conversation'>) => call('rpc_agent_return_conversation', a),
  agentDismissAttention: (a: Args<'rpc_agent_dismiss_attention'>) => call('rpc_agent_dismiss_attention', a),
  agentRecentMessages: (a: Args<'rpc_agent_recent_messages'>) => call('rpc_agent_recent_messages', a),
} as const

/** pt-BR message for any thrown value (RpcError carries the mapped text). */
export function messageOf(e: unknown): string {
  if (e instanceof RpcError) return e.message
  if (e instanceof Error) return e.message
  return 'Algo deu errado. Tente novamente.'
}
