import { describe, expect, it } from 'vitest'
import { applyTitleCompletion, matchTitleHints } from './titleKeywordHints'

describe('matchTitleHints', () => {
  it('completes a specific word from a prefix', () => {
    expect(matchTitleHints('поменять картр')).toContain('картридж')
    expect(matchTitleHints('поменять картр')).not.toContain('Заправить картридж')
  })

  it('does not suggest refill-cartridge canned titles', () => {
    const hints = matchTitleHints('картридж')
    expect(hints.join(' ')).not.toMatch(/заправ/i)
  })

  it('stays quiet when the last word is already complete', () => {
    expect(matchTitleHints('поменять картридж')).not.toContain('картридж')
  })

  it('stays quiet for short noise', () => {
    expect(matchTitleHints('а')).toEqual([])
  })
})

describe('applyTitleCompletion', () => {
  it('replaces the unfinished last word', () => {
    expect(applyTitleCompletion('поменять картр', 'картридж')).toBe('поменять картридж')
  })
})
