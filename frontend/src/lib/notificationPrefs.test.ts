import { describe, expect, it } from 'vitest'
import { unreadAssigned } from './notificationPrefs'

describe('unreadAssigned', () => {
  it('returns nothing when notifications disabled', () => {
    expect(unreadAssigned([{ id: 1 }, { id: 2 }], { enabled: false, readIds: [] })).toEqual([])
  })

  it('filters out read ids', () => {
    expect(unreadAssigned([{ id: 1 }, { id: 2 }, { id: 3 }], { enabled: true, readIds: [2] })).toEqual([
      { id: 1 },
      { id: 3 },
    ])
  })
})
