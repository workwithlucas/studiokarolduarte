// Output gate for Thaís' replies: forbidden phrases, question limit and message splitting.

const MEDIA = '(?:imagens?|fotos?|figurinhas?|stickers?|[áa]udios?|voz|mensagens? de voz|v[íi]deos?|arquivos?|anexos?|prints?)'
const B = '(?<![A-Za-zÀ-ÿ])' // \b is ASCII-only: it does not work before accented letters like á
const SEE = '(?:ver|abrir|ler|ouvir|escutar|entender|interpretar|visualizar|assistir|reproduzir|receber|acessar|baixar|analisar)'
const CANT = '(?:n[ãa]o\\s+(?:consigo|posso|sei|estou\\s+conseguindo|tenho\\s+como|d[áa]\\s+(?:pra|para)|tenho\\s+acesso)|sem\\s+(?:como|condi[çc][õo]es\\s+de)|n[ãa]o\\s+[ée]\\s+poss[íi]vel)'

export const FORBIDDEN_PATTERNS: RegExp[] = [
  // "não consigo ver/ouvir/abrir ... imagem/áudio/figurinha"
  new RegExp(`${CANT}[^.!?\\n]{0,40}\\b${SEE}\\b[^.!?\\n]{0,60}${B}${MEDIA}\\b`, 'i'),
  new RegExp(`${CANT}[^.!?\\n]{0,40}${B}${MEDIA}\\b`, 'i'),
  // "não ouço/escuto/leio/vejo áudios"
  new RegExp(`n[ãa]o\\s+(?:ou[cç]o|escuto|leio|vejo|recebo|abro|entendo)\\b[^.!?\\n]{0,40}${B}${MEDIA}\\b`, 'i'),
  // "meu sistema não lê áudios"
  new RegExp(`\\b(?:sistema|aparelho|whatsapp)\\b[^.!?\\n]{0,40}n[ãa]o\\s+(?:l[êe]|abre|ouve|reconhece|suporta|aceita|recebe)[^.!?\\n]{0,40}${B}${MEDIA}\\b`, 'i'),
  // asks to send as text
  /\b(?:pode|poderia|consegue|manda|mande|envie|enviar|mandar|escreva|escrever|digite|digitar)\b[^.!?\n]{0,50}\b(?:por|em|como|via)\s+(?:texto|escrito|mensagem\s+de\s+texto|mensagem\s+escrita)\b/i,
  /\b(?:mandar|enviar|escrever|digitar)\b[^.!?\n]{0,30}\bpor\s+escrito\b/i,
  /\bem\s+formato\s+de\s+texto\b/i,
  /\bapenas\s+(?:mensagens?\s+)?(?:de\s+)?texto\b/i,
]

export function hasForbiddenPhrase(text: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(text))
}

/** Sentence units, keeping the trailing punctuation. Line breaks are handled by the caller. */
export function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Drops every sentence that matches a forbidden pattern. */
export function dropForbiddenSentences(text: string): string {
  return text
    .split('\n')
    .map((line) => splitSentences(line).filter((s) => !hasForbiddenPhrase(s)).join(' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const MAX_MESSAGES = 2
export const MAX_LINES = 3
export const MAX_CHARS = 320

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf(','))
  return (at > max * 0.5 ? cut.slice(0, at) : cut).trimEnd().replace(/[,;:]$/, '') + '.'
}

/** Keeps only the first question (sentence ending in "?"): later questions are dropped. */
export function limitQuestions(text: string): string {
  let seen = false
  return text
    .split('\n')
    .map((line) =>
      splitSentences(line)
        .filter((s) => {
          if (!s.endsWith('?')) return true
          if (seen) return false
          seen = true
          return true
        })
        .join(' '),
    )
    .join('\n')
}

/**
 * Turns the model's final text into at most 2 messages, each at most 3 lines and 320 chars.
 * Paragraph breaks are respected as message boundaries; overflow is dropped sentence by sentence.
 */
export function formatReply(text: string): string[] {
  const limited = limitQuestions(text.replace(/\r/g, '').trim())
  const paragraphs = limited.split(/\n{2,}/).map((p) =>
    p
      .split('\n')
      .flatMap((l) => splitSentences(l.trim()))
      .filter(Boolean),
  )
  const messages: string[][] = []
  let current: string[] = []
  const chars = (lines: string[]) => lines.join('\n').length
  const flush = () => {
    if (current.length) messages.push(current)
    current = []
  }
  for (const units of paragraphs) {
    if (units.length === 0) continue
    if (current.length && messages.length + 1 < MAX_MESSAGES) flush() // paragraph break = new message
    for (const raw of units) {
      const unit = clip(raw, MAX_CHARS)
      if (current.length >= MAX_LINES || chars([...current, unit]) > MAX_CHARS) {
        if (messages.length + 1 >= MAX_MESSAGES) {
          flush()
          return messages.slice(0, MAX_MESSAGES).map((m) => m.join('\n'))
        }
        flush()
      }
      current.push(unit)
    }
  }
  flush()
  return messages.slice(0, MAX_MESSAGES).map((m) => m.join('\n'))
}
