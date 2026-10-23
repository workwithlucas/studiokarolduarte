// Contracts shared by the finance assistant (function) and its UI. Pure types, no runtime code.

export type ActionKind =
  | 'create_entry'
  | 'register_payments'
  | 'complete_and_pay'
  | 'apply_package'
  | 'reverse_payment'
  | 'void_entry'
  | 'edit_entry'
  | 'add_credit'
  | 'settle_account'

export interface CardLine {
  label: string
  value: string
}

/** Built by code from values re-read from the database; the model never writes any of it. */
export interface ActionSummary {
  title: string
  lines: CardLine[]
  warnings: string[]
}

export interface PendingActionItem {
  kind: ActionKind
  params: Record<string, unknown>
  summary: ActionSummary
}

export interface UndoStep {
  rpc: string
  args: Record<string, unknown>
}

export interface UndoItem {
  index: number
  label: string
  steps: UndoStep[]
  done: boolean
}

export interface ResultLine {
  index: number
  ok: boolean
  text: string
}

export interface ChoiceOption {
  label: string
  detail: string
  value: string
}

export type ChoiceSlot = 'entry_id' | 'payment_id' | 'client_id'

export interface ProposalCard {
  kind: 'proposal'
  pending_id: string
  expires_at: string
  actions: ActionSummary[]
}
export interface ChoiceCard {
  kind: 'choice'
  choice_id: string
  slot: ChoiceSlot
  question: string
  options: ChoiceOption[]
  /** What to run again once a candidate is picked. Validated server-side data, never read from the client. */
  intent: { tool: string; input: Record<string, unknown>; carry: PendingActionItem[] }
}
export interface QuestionCard {
  kind: 'question'
  question: string
  options: Array<{ label: string; value: string }>
}
export interface EntriesCard {
  kind: 'entries'
  title: string
  total: number
  rows: Array<{ title: string; detail: string; value: string; status: string }>
}
export interface FactsCard {
  kind: 'facts'
  title: string
  lines: CardLine[]
}
export interface ResultCard {
  kind: 'result'
  pending_id: string
  lines: ResultLine[]
}
export type Card = ProposalCard | ChoiceCard | QuestionCard | EntriesCard | FactsCard | ResultCard

export interface MessageView {
  id: string
  role: 'user' | 'assistant' | 'card'
  body: string | null
  card: Card | null
  created_at: string
}

/** State of a pending row as the UI needs it (the statuses live in the database, never in the card). */
export interface PendingView {
  id: string
  status: 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'failed'
  expires_at: string
  undoable: number[]
}

export interface AssistantResponse {
  messages: MessageView[]
  pendings: PendingView[]
}

export type AssistantBody =
  | { action: 'message'; text: string; pick?: { choice_id: string; value: string }; request_id?: string }
  | { action: 'confirm'; pending_id: string; request_id?: string }
  | { action: 'cancel'; pending_id: string; request_id?: string }
  | { action: 'undo'; pending_id: string; action_index?: number; request_id?: string }
  | { action: 'new_thread'; request_id?: string }
  | { action: 'list_threads'; limit?: number }
  | { action: 'get_thread'; thread_id: string }
  | { action: 'list_actions'; limit?: number; offset?: number }
  | { action: 'undo_logged'; pending_id: string; action_index: number }

export interface ThreadSummary {
  thread_id: string
  title: string
  started_at: string
  archived_at: string
  message_count: number
}
export interface ThreadsResponse {
  threads: ThreadSummary[]
}

export type ActionLogStatus = 'done' | 'undone' | 'failed'
/** One row of assistant_actions_log plus whether its undo data is still there (the pending row lives 90 days). */
export interface ActionLogItem {
  pending_id: string
  action_index: number
  kind: string
  summary: string
  amount_cents: number | null
  entry_id: string | null
  client_name: string | null
  status: ActionLogStatus
  error_code: string | null
  executed_at: string
  undone_at: string | null
  undoable: boolean
}
export interface ActionsResponse {
  actions: ActionLogItem[]
  has_more: boolean
}
export interface UndoLoggedResponse {
  ok: boolean
  message: string
}
