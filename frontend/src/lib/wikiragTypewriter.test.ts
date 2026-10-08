import { describe, expect, it } from 'vitest'
import { nextTypewriterChunk, typewriterWordsForBacklog } from './wikiragTypewriter'

describe('wikiragTypewriter', () => {
  it('reveals the first word then the rest', () => {
    const target = 'Баобаб растёт в Африке'
    const first = nextTypewriterChunk('', target)
    expect(first).toBe('Баобаб')
    const second = nextTypewriterChunk(first, target)
    expect(second).toBe('Баобаб растёт')
    const rest = nextTypewriterChunk(second, target, 8)
    expect(rest).toBe(target)
  })

  it('restarts when the extracted answer replaces the buffer', () => {
    const shown = '{"answer":'
    const next = nextTypewriterChunk(shown, 'Баобаб — дерево.')
    expect(next).toContain('Баобаб')
    expect(next).not.toContain('{')
  })

  it('speeds up when the backlog is large', () => {
    expect(typewriterWordsForBacklog(12)).toBe(1)
    expect(typewriterWordsForBacklog(300)).toBe(5)
  })
})
