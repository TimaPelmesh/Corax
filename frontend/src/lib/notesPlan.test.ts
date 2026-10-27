import { describe, expect, it } from 'vitest'
import { formatNotePlanRange } from './notesPlan'

describe('formatNotePlanRange', () => {
  it('returns null when both empty', () => {
    expect(formatNotePlanRange(null, null)).toBeNull()
    expect(formatNotePlanRange('', '')).toBeNull()
  })

  it('shows single date for same-day plan', () => {
    expect(formatNotePlanRange('2026-07-27', '2026-07-27')).toBe('2026-07-27')
  })

  it('shows range with arrow', () => {
    expect(formatNotePlanRange('2026-07-01', '2026-07-10')).toBe('2026-07-01 → 2026-07-10')
  })

  it('falls back to one side', () => {
    expect(formatNotePlanRange('2026-07-01', null)).toBe('2026-07-01')
    expect(formatNotePlanRange(null, '2026-07-10')).toBe('2026-07-10')
  })
})
