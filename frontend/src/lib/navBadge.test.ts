import { describe, expect, it } from 'vitest'
import { formatNavBadge } from './navBadge'

describe('formatNavBadge', () => {
  it('stringifies small counts', () => {
    expect(formatNavBadge(0)).toBe('0')
    expect(formatNavBadge(42)).toBe('42')
    expect(formatNavBadge(999)).toBe('999')
  })

  it('caps at 999+', () => {
    expect(formatNavBadge(1000)).toBe('999+')
    expect(formatNavBadge(12_345)).toBe('999+')
  })
})
