import { describe, expect, it } from 'vitest'
import {
  clampHoverCardPosition,
  HOVER_CARD_WIDTH,
  isOutletKind,
  markerCircleRadius,
  markerTitle,
  normalizeLayout,
  parseViewBox,
  splitLabelLines,
} from './floorTools'

describe('parseViewBox', () => {
  it('parses four numbers', () => {
    expect(parseViewBox('10 20 800 600')).toEqual({ x: 10, y: 20, w: 800, h: 600 })
  })

  it('falls back on junk', () => {
    expect(parseViewBox('nope')).toEqual({ x: 0, y: 0, w: 1200, h: 800 })
  })
})

describe('normalizeLayout', () => {
  it('fills missing arrays', () => {
    const layout = normalizeLayout(null)
    expect(layout.rooms).toEqual([])
    expect(layout.icons).toEqual([])
    expect(layout.version).toBe(1)
  })
})

describe('outlets and labels', () => {
  it('treats ethernet as an outlet with a smaller radius', () => {
    expect(isOutletKind('ethernet_outlet')).toBe(true)
    expect(isOutletKind('pc')).toBe(false)
    expect(markerCircleRadius('ethernet_outlet')).toBe(11)
    expect(markerCircleRadius('pc')).toBe(22)
  })

  it('titles an outlet by number', () => {
    expect(
      markerTitle({
        id: 'o1',
        kind: 'ethernet_outlet',
        x: 0,
        y: 0,
        label: '',
        meta: { outlet_number: '12' },
      }),
    ).toBe('№ 12')
  })

  it('splits long labels into two lines', () => {
    expect(splitLabelLines('Серверная комната А')).toEqual(['Серверная комната', 'А'])
  })
})

describe('clampHoverCardPosition', () => {
  const view = { x: 0, y: 0, w: 1200, h: 800 }
  const cardH = 140

  it('keeps the preferred right-above placement near the center', () => {
    const pos = clampHoverCardPosition({
      markerX: 600,
      markerY: 400,
      cardW: HOVER_CARD_WIDTH,
      cardH,
      view,
    })
    expect(pos).toEqual({ x: 628, y: 336 })
  })

  it('flips left near the right edge', () => {
    const pos = clampHoverCardPosition({
      markerX: 1180,
      markerY: 400,
      cardW: HOVER_CARD_WIDTH,
      cardH,
      view,
    })
    expect(pos.x).toBeLessThan(1180)
    expect(pos.x + HOVER_CARD_WIDTH).toBeLessThanOrEqual(view.w - 8)
    expect(pos.x).toBeGreaterThanOrEqual(8)
  })

  it('flips below near the top edge', () => {
    const pos = clampHoverCardPosition({
      markerX: 600,
      markerY: 20,
      cardW: HOVER_CARD_WIDTH,
      cardH,
      view,
    })
    expect(pos.y).toBeGreaterThanOrEqual(20)
    expect(pos.y).toBe(48)
  })

  it('clamps into the viewport at the top-right corner', () => {
    const pos = clampHoverCardPosition({
      markerX: 1190,
      markerY: 10,
      cardW: HOVER_CARD_WIDTH,
      cardH,
      view,
    })
    expect(pos.x).toBeGreaterThanOrEqual(8)
    expect(pos.y).toBeGreaterThanOrEqual(8)
    expect(pos.x + HOVER_CARD_WIDTH).toBeLessThanOrEqual(view.w - 8)
    expect(pos.y + cardH).toBeLessThanOrEqual(view.h - 8)
  })

  it('clamps into the viewport at the bottom-left corner', () => {
    const pos = clampHoverCardPosition({
      markerX: 10,
      markerY: 790,
      cardW: HOVER_CARD_WIDTH,
      cardH,
      view,
    })
    expect(pos.x).toBeGreaterThanOrEqual(8)
    expect(pos.y).toBeGreaterThanOrEqual(8)
    expect(pos.x + HOVER_CARD_WIDTH).toBeLessThanOrEqual(view.w - 8)
    expect(pos.y + cardH).toBeLessThanOrEqual(view.h - 8)
  })
})
