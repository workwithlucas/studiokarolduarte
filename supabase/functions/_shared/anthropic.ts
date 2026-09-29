// Anthropic Messages API via fetch (no SDK).
import type { FetchFn } from './types.ts'

export interface TextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | Record<string, unknown>
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}
export interface ToolDef {
  name: string
  description: string
  input_schema: Record<string, unknown>
}
export interface MessagesRequest {
  model: string
  max_tokens: number
  temperature?: number
  system?: TextBlock[]
  messages: ChatMessage[]
  tools?: ToolDef[]
  tool_choice?: { type: 'auto' | 'none' | 'any' }
}
export interface MessagesResponse {
  content: Array<TextBlock | ToolUseBlock>
  stop_reason: string
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

export async function callMessages(
  fetchFn: FetchFn,
  apiKey: string | undefined,
  req: MessagesRequest,
  timeoutMs: number,
): Promise<MessagesResponse> {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing')
  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
  })
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`anthropic HTTP ${res.status}: ${text}`)
  }
  return (await res.json()) as MessagesResponse
}

export function textOf(res: MessagesResponse): string {
  return res.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

export function base64OfBytes(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}
