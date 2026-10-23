// pt-BR text for every rule-violation code. Server-side twin of ERROR_MESSAGES in src/lib/rpc.ts:
// a vitest asserts both have the same codes. Never rename a code.

export const ERROR_MESSAGES: Record<string, string> = {
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
  SERVICE_LOCKED_PAID: 'Estorne o pagamento antes de alterar o serviço.',
  PACKAGE_SERVICE_MISMATCH: 'Este serviço não é coberto pelo pacote do agendamento.',
}

/** pt-BR message for a code; `detail` (database text) is used for codes this table does not know. */
export function messageOfCode(code: string | null | undefined, detail?: string | null): string {
  if (code && code in ERROR_MESSAGES) return ERROR_MESSAGES[code]!
  return detail?.trim() || 'Algo deu errado. Tente novamente.'
}
