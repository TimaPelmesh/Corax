/** Live and final generation speed. Shown only for Ollama. */

/** A stream chunk is not a token. Tiny chunks (one letter each) would inflate tok/s. */
export function streamTokenCount(chunks: number, chars: number): number {
  if (chars > 0) {
    const byChars = chars / 4
    if (chunks > byChars * 1.35) return byChars
  }
  return chunks
}

export function ollamaTokenRate(input: {
  provider?: string | null
  streaming: boolean
  streamTokens?: number
  streamChars?: number
  streamStartedAt?: number
  tokensPerSecond?: number | null
  now?: number
}): number | null {
  const provider = input.provider
  if (provider !== 'ollama') return null
  const saved = input.tokensPerSecond
  if (!input.streaming && typeof saved === 'number' && saved > 0) return saved
  const tokens = streamTokenCount(input.streamTokens ?? 0, input.streamChars ?? 0)
  const started = input.streamStartedAt
  if (input.streaming && tokens >= 2 && started != null) {
    const sec = ((input.now ?? Date.now()) - started) / 1000
    if (sec >= 0.35) return tokens / sec
  }
  if (typeof saved === 'number' && saved > 0) return saved
  return null
}

export function formatTokenRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return ''
  if (rate >= 100) return String(Math.round(rate))
  return rate.toFixed(1)
}

export function settledTokenRate(
  meta: { provider?: string; llm?: { provider?: string; tokens_per_second?: number } | null } | null | undefined,
  measured?: number,
): number | undefined {
  const provider = meta?.llm?.provider || meta?.provider
  if (provider !== 'ollama') return undefined
  const server = meta?.llm?.tokens_per_second
  if (typeof server === 'number' && server > 0) return server
  if (typeof measured === 'number' && measured > 0) return Math.round(measured * 10) / 10
  return undefined
}

export function measuredTokenRate(
  streamTokens?: number,
  streamStartedAt?: number,
  now = Date.now(),
  streamChars?: number,
): number | undefined {
  const tokens = streamTokenCount(streamTokens ?? 0, streamChars ?? 0)
  if (tokens < 2 || streamStartedAt == null) return undefined
  const sec = (now - streamStartedAt) / 1000
  if (sec < 0.05) return undefined
  return tokens / sec
}
