// Media at ingest: audio -> Groq transcript, image -> one short Claude vision description.
import { base64OfBytes, callMessages, textOf } from './anthropic.ts'
import type { Deps, FetchFn } from './types.ts'

export const AUDIO_MAX_BYTES = 25 * 1024 * 1024
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** Downloads with a timeout and a hard size cap (checks Content-Length and the real size). */
export async function downloadCapped(
  fetchFn: FetchFn,
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ bytes: Uint8Array; contentType: string | null }> {
  if (!/^https:\/\//i.test(url)) throw new Error('media url must be https')
  const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`download HTTP ${res.status}`)
  const declared = Number(res.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new Error('media too large')
  const buf = new Uint8Array(await res.arrayBuffer())
  if (buf.byteLength > maxBytes) throw new Error('media too large')
  return { bytes: buf, contentType: res.headers.get('content-type') }
}

/** Returns the transcript, or null on any failure (the caller counts it in audio_failures). */
export async function transcribeAudio(deps: Deps, url: string | null): Promise<string | null> {
  try {
    if (!url || !deps.cfg.groqKey) return null
    const { bytes } = await downloadCapped(deps.fetch, url, AUDIO_MAX_BYTES, 15_000)
    const form = new FormData()
    form.append('file', new Blob([bytes as BlobPart], { type: 'audio/ogg' }), 'audio.ogg')
    form.append('model', 'whisper-large-v3-turbo')
    form.append('language', 'pt')
    form.append('response_format', 'json')
    const res = await deps.fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${deps.cfg.groqKey}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const json = (await res.json()) as { text?: unknown }
    const text = typeof json.text === 'string' ? json.text.trim() : ''
    return text || null
  } catch (e) {
    deps.log('audio_failed', { error: String(e instanceof Error ? e.message : e) })
    return null
  }
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

/** "[imagem: <short description>]", or "[imagem]" on any failure. One vision call, max_tokens 120. */
export async function describeImage(deps: Deps, url: string | null, mimeHint: string | null, caption: string | null): Promise<string> {
  const suffix = caption ? ` ${caption}` : ''
  try {
    if (!url) return `[imagem]${suffix}`
    const { bytes, contentType } = await downloadCapped(deps.fetch, url, IMAGE_MAX_BYTES, 15_000)
    const type = [contentType, mimeHint].map((t) => (t ?? '').split(';')[0]!.trim().toLowerCase()).find((t) => IMAGE_TYPES.includes(t))
    if (!type) return `[imagem]${suffix}`
    const res = await callMessages(
      deps.fetch,
      deps.cfg.anthropicKey,
      {
        model: deps.cfg.model,
        max_tokens: 120,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: type, data: base64OfBytes(bytes) } },
              {
                type: 'text',
                text: 'Descreva em português, em no máximo 15 palavras, o que aparece nesta imagem (ex.: "unhas com francesinha", "cílios volume russo", "comprovante de pagamento"). Responda só com a descrição.',
              },
            ],
          },
        ],
      },
      20_000,
    )
    const desc = textOf(res).replace(/\s+/g, ' ').replace(/[\[\]]/g, '').slice(0, 160)
    return desc ? `[imagem: ${desc}]${suffix}` : `[imagem]${suffix}`
  } catch (e) {
    deps.log('image_failed', { error: String(e instanceof Error ? e.message : e) })
    return `[imagem]${suffix}`
  }
}
