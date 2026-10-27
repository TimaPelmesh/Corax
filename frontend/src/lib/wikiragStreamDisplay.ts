/**
 * Stream display: show only the readable answer.
 * Hide thinking / English CoT / JSON scaffolding until real answer text appears.
 */

const THINK_OPEN_RE = /<\s*think\b[^>]*>/gi
const THINK_CLOSE_RE = /<\s*\/\s*think\s*>/gi
const THINK_BLOCK_RE = /<\s*think\b[^>]*>[\s\S]*?<\s*\/\s*think\s*>/gi
const CYRILLIC_RE = /[а-яёА-ЯЁ]/g

const REASONING_MARKERS = [
  "here's a thinking",
  'thinking process',
  'analyze the request',
  'self-correction',
  'simulate data analysis',
  'since no data is provided',
  'no actual data',
  'i must assume',
  'structure the response',
  'review constraints',
  'let me think',
  'step by step',
  'first, i need',
  'the user asks',
  'looking at the context',
]

function unwrapClosedThink(text: string): string {
  return (text || '').replace(THINK_BLOCK_RE, '').replace(THINK_OPEN_RE, '').replace(THINK_CLOSE_RE, '')
}

function hasOpenThink(text: string): boolean {
  const opens = (text.match(THINK_OPEN_RE) || []).length
  const closes = (text.match(THINK_CLOSE_RE) || []).length
  THINK_OPEN_RE.lastIndex = 0
  THINK_CLOSE_RE.lastIndex = 0
  return opens > closes
}

function cyrillicRatio(text: string): number {
  if (!text) return 0
  const cyr = (text.match(CYRILLIC_RE) || []).length
  CYRILLIC_RE.lastIndex = 0
  return cyr / Math.max(text.length, 1)
}

function looksLikeReasoningDump(text: string): boolean {
  const low = (text || '').trim().toLowerCase()
  if (!low) return false
  if (REASONING_MARKERS.some((m) => low.includes(m))) return true
  // Long mostly-Latin dumps while streaming = CoT, not the final answer.
  if (low.length > 120 && cyrillicRatio(low.slice(0, 800)) < 0.06) return true
  return false
}

function extractRussianBlocks(text: string): string {
  const blocks = (text || '')
    .split(/\n\s*\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length >= 24 && cyrillicRatio(b) >= 0.12)
  return blocks.join('\n\n')
}

/** Pull answer from partial/complete JSON wrappers some models emit. */
function extractAnswerField(text: string): string | null {
  const t = text.trim()
  if (!t.includes('"answer"')) return null
  try {
    const o = JSON.parse(t) as { answer?: unknown }
    if (typeof o.answer === 'string' && o.answer.trim()) return o.answer.trim()
  } catch {
    /* partial JSON */
  }
  const m = t.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)"/s)
  if (m?.[1]) {
    return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim()
  }
  const m2 = t.match(/"answer"\s*:\s*"(.*)/s)
  if (m2?.[1]) {
    let tail = m2[1]
    const cut = tail.split(/"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"/)[0]
    tail = cut ?? tail
    return tail
      .replace(/"\s*\}\s*$/, '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .trim()
  }
  return null
}

function isJsonScaffold(text: string): boolean {
  const t = text.trim()
  return /^\s*\{/.test(t) || /"answer"\s*:/.test(t) || /"confidence"\s*:/.test(t)
}

export type StreamDisplay = {
  text: string
  /** True while model is thinking / dumping CoT — UI shows a calm status, not raw tokens. */
  waiting: boolean
}

/**
 * Convert accumulated stream buffer into user-facing text.
 * Prefer silence + waiting over showing English reasoning or half-baked JSON.
 */
export function streamDisplayText(
  raw: string,
  { streaming = false }: { streaming?: boolean } = {},
): StreamDisplay {
  const rawTrim = (raw || '').trim()
  if (!rawTrim) return { text: '', waiting: streaming }

  // Still inside <think>… — do not flash CoT into the bubble.
  if (hasOpenThink(rawTrim)) {
    return { text: '', waiting: true }
  }

  let stripped = unwrapClosedThink(rawTrim).replace(/^\s+/, '')
  if (!stripped) return { text: '', waiting: streaming }

  const fromJson = extractAnswerField(stripped)
  if (fromJson) {
    if (streaming && looksLikeReasoningDump(fromJson) && !extractRussianBlocks(fromJson)) {
      return { text: '', waiting: true }
    }
    const russian = extractRussianBlocks(fromJson)
    if (russian && looksLikeReasoningDump(fromJson)) {
      return { text: russian, waiting: false }
    }
    return { text: fromJson, waiting: false }
  }

  // Incomplete JSON object — wait for a parseable answer field.
  if (streaming && isJsonScaffold(stripped)) {
    return { text: '', waiting: true }
  }

  if (looksLikeReasoningDump(stripped)) {
    const russian = extractRussianBlocks(stripped)
    if (russian) return { text: russian, waiting: false }
    return { text: '', waiting: streaming }
  }

  return { text: stripped, waiting: false }
}

/** Final message display — never leave the user with raw CoT if we can salvage Russian. */
export function cleanAssistantText(raw: string): string {
  const live = streamDisplayText(raw, { streaming: false })
  if (live.text.trim()) return live.text
  const stripped = unwrapClosedThink(raw || '').trim()
  if (!stripped) return ''
  if (looksLikeReasoningDump(stripped)) {
    return extractRussianBlocks(stripped) || stripped
  }
  const fromJson = extractAnswerField(stripped)
  return fromJson || stripped
}
