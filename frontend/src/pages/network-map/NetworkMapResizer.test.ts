import { describe, expect, it } from 'vitest'
import { applyCornerResize } from './NetworkMapResizer'

describe('applyCornerResize', () => {
  const start = { x: 100, y: 80, width: 120, height: 80 }

  it('grows from the south-east corner without moving the origin', () => {
    expect(applyCornerResize(start, { x: 20, y: 12 }, 'se', 40, 40, 400, 400)).toEqual({
      x: 100,
      y: 80,
      width: 140,
      height: 92,
    })
  })

  it('keeps the east edge fixed when dragging the west side', () => {
    const next = applyCornerResize(start, { x: 20, y: 0 }, 'sw', 40, 40, 400, 400)
    expect(next.x + next.width).toBe(start.x + start.width)
    expect(next.y).toBe(start.y)
  })
})
