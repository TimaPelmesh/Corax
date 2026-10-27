import { describe, expect, it } from 'vitest'
import { nextTypewriterChunk, typewriterDelayMs } from './wikiragTypewriter'

describe('wikiragTypewriter', () => {
  it('shows a short token at once', () => {
    expect(nextTypewriterChunk('', 'Баобаб')).toBe('Баобаб')
    expect(nextTypewriterChunk('Баобаб', 'Баобаб растёт')).toBe('Баобаб растёт')
  })

  it('eases a long burst by characters and then catches the rest', () => {
    const target = 'Баобаб растёт в саванне и живёт очень долго.'
    const first = nextTypewriterChunk('', target)
    expect(first.length).toBeGreaterThan(4)
    expect(first.length).toBeLessThan(target.length)
    expect(target.startsWith(first)).toBe(true)
    expect(nextTypewriterChunk(first, target).length).toBeGreaterThan(first.length)
  })

  it('restarts from the shared prefix when the answer replaces the buffer', () => {
    const next = nextTypewriterChunk('{"answer":', 'Баобаб — дерево.')
    expect(next.startsWith('Б')).toBe(true)
    expect(next).not.toContain('{')
  })

  it('keeps the caret close to a long queue', () => {
    expect(typewriterDelayMs(12)).toBeGreaterThan(typewriterDelayMs(800))
    expect(typewriterDelayMs(800)).toBeLessThanOrEqual(12)
  })
})
