import { describe, expect, it } from 'vitest'
import { cleanAssistantText, streamDisplayText } from './wikiragStreamDisplay'

describe('wikiragStreamDisplay', () => {
  it('hides open think and waits while streaming', () => {
    const r = streamDisplayText('<think>planning steps in english', { streaming: true })
    expect(r.waiting).toBe(true)
    expect(r.text).toBe('')
  })

  it('strips closed think tags and shows answer', () => {
    const r = streamDisplayText(
      '<think>hidden</think>\n\n### Итог\n**Windows 7** ещё на двух ПК.',
      { streaming: true },
    )
    expect(r.waiting).toBe(false)
    expect(r.text).toContain('Windows 7')
    expect(r.text).not.toMatch(/<\/?think/i)
  })

  it('hides english reasoning while streaming', () => {
    const dump =
      "Here's a thinking process.\nAnalyze the request carefully.\nSelf-correction: I must assume no data."
    const r = streamDisplayText(dump, { streaming: true })
    expect(r.waiting).toBe(true)
    expect(r.text).toBe('')
  })

  it('prefers JSON answer field when present', () => {
    const r = streamDisplayText('{"answer":"На парке 3 ПК с Windows 7.","confidence":"high"}', {
      streaming: false,
    })
    expect(r.waiting).toBe(false)
    expect(r.text).toContain('Windows 7')
  })

  it('waits on incomplete JSON scaffold while streaming', () => {
    const r = streamDisplayText('{"answer":', { streaming: true })
    expect(r.waiting).toBe(true)
    expect(r.text).toBe('')
  })

  it('cleanAssistantText unwraps think tags but keeps inner answer', () => {
    expect(cleanAssistantText('<think>x</think>\nГотово.')).toContain('Готово.')
    expect(cleanAssistantText('<think>x</think>\nГотово.')).not.toMatch(/<\/?think/i)
  })
})
