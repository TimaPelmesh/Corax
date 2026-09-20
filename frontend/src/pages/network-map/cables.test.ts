import { describe, expect, it } from 'vitest'
import { contentBounds, exportPixelSize, laneForEdges, pairKey, safeFilename } from './cables'

describe('laneForEdges', () => {
  it('keeps a single cable on the center lane', () => {
    const lanes = laneForEdges([{ id: 'a', source: 'sw', target: 'ap' }])
    expect(lanes.get('a')).toBe(0)
  })

  it('spreads two cables on the same pair', () => {
    const lanes = laneForEdges([
      { id: 'a', source: 'sw', target: 'ap' },
      { id: 'b', source: 'ap', target: 'sw' },
    ])
    expect(pairKey('sw', 'ap')).toBe(pairKey('ap', 'sw'))
    expect(lanes.get('a')).toBe(-0.5)
    expect(lanes.get('b')).toBe(0.5)
  })
})

describe('export sizing', () => {
  it('pads node bounds and caps megapixel exports', () => {
    const bounds = contentBounds([{ position: { x: 0, y: 0 }, width: 100, height: 80 }], 20)
    expect(bounds.width).toBeGreaterThan(100)
    const px = exportPixelSize({ width: 4000, height: 4000 }, 3, 6000)
    expect(px.width).toBeLessThanOrEqual(6000)
    expect(px.height).toBeLessThanOrEqual(6000)
  })

  it('sanitizes download names', () => {
    expect(safeFilename('Схема: ядро/1')).toBe('Схема-ядро1')
  })
})
