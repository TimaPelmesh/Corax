import { describe, expect, it } from 'vitest'
import { formatTokenRate, ollamaTokenRate, settledTokenRate } from './wikiragTokenRate'

describe('ollamaTokenRate', () => {
  it('hides the rate until a few tokens have landed', () => {
    expect(
      ollamaTokenRate({
        provider: 'ollama',
        streaming: true,
        streamTokens: 1,
        streamStartedAt: 1_000,
        now: 2_000,
      }),
    ).toBeNull()
  })

  it('counts streamed chunks while Ollama is still writing', () => {
    const rate = ollamaTokenRate({
      provider: 'ollama',
      streaming: true,
      streamTokens: 20,
      streamChars: 80,
      streamStartedAt: 0,
      now: 1_000,
    })
    expect(rate).toBe(20)
  })

  it('does not treat one-letter chunks as tokens', () => {
    const rate = ollamaTokenRate({
      provider: 'ollama',
      streaming: true,
      streamTokens: 40,
      streamChars: 40,
      streamStartedAt: 0,
      now: 1_000,
    })
    expect(rate).toBe(10)
  })

  it('keeps the settled Ollama rate after the answer finishes', () => {
    expect(
      ollamaTokenRate({
        provider: 'ollama',
        streaming: false,
        tokensPerSecond: 34.2,
      }),
    ).toBe(34.2)
  })

  it('stays quiet for other providers', () => {
    expect(
      settledTokenRate({ provider: 'lm_studio', llm: { tokens_per_second: 40 } }, 12),
    ).toBeUndefined()
    expect(formatTokenRate(34.24)).toBe('34.2')
    expect(formatTokenRate(120.4)).toBe('120')
  })
})
