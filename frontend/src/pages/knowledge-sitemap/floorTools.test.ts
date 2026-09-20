import { describe, expect, it } from 'vitest'
import {
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
