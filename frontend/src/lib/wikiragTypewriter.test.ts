import { describe, expect, it } from 'vitest'
import { nextTypewriterChunk, typewriterDelayMs } from './wikiragTypewriter'

describe('wikiragTypewriter', () => {
  it('shows one word, then the next', () => {
    expect(nextTypewriterChunk('', 'Баобаб')).toBe('Баобаб')
    expect(nextTypewriterChunk('Баобаб', 'Баобаб растёт')).toBe('Баобаб растёт')
    expect(nextTypewriterChunk('', 'Один два три')).toBe('Один')
    expect(nextTypewriterChunk('Один', 'Один два три')).toBe('Один два')
  })

  it('does not dump a sentence on the first frame', () => {
    const target = 'Баобаб растёт в саванне и живёт очень долго среди слонов'
    const first = nextTypewriterChunk('', target)
    expect(first).toBe('Баобаб')
    expect(first.length).toBeLessThan(target.length)
    expect(nextTypewriterChunk(first, target).startsWith('Баобаб растёт')).toBe(true)
  })

  it('takes a few words when the model is far ahead, not half the answer', () => {
    const target = Array.from({ length: 80 }, (_, i) => `слово${i}`).join(' ')
    const first = nextTypewriterChunk('', target)
    const count = first.split(/\s+/).length
    expect(count).toBeGreaterThan(1)
    expect(count).toBeLessThan(6)
    expect(target.startsWith(first)).toBe(true)
    expect(first.length).toBeLessThan(target.length / 2)
  })

  it('restarts from the shared prefix when the answer replaces the buffer', () => {
    const next = nextTypewriterChunk('{"answer":', 'Баобаб — дерево.')
    expect(next.startsWith('Б')).toBe(true)
    expect(next).not.toContain('{')
  })

  it('keeps a long queue faster than a short one, still frame by frame', () => {
    expect(typewriterDelayMs(12)).toBeGreaterThan(typewriterDelayMs(800))
    expect(typewriterDelayMs(800)).toBeGreaterThanOrEqual(16)
    expect(typewriterDelayMs(800)).toBeLessThanOrEqual(20)
  })
})
