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
