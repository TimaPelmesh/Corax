import { describe, expect, it } from 'vitest'
import { equipmentHeight, equipmentWidth, viewportFlowCenter } from './flow'
import { absoluteExportBoxes, contentBounds } from './cables'

describe('viewportFlowCenter', () => {
  it('maps the pane center into flow coordinates', () => {
    const pos = viewportFlowCenter({ x: -200, y: -40, zoom: 1 }, { width: 800, height: 400 })
    expect(pos.x).toBe(600)
    expect(pos.y).toBe(240)
  })
})

describe('equipment size', () => {
  it('keeps a custom width for switches', () => {
    expect(equipmentWidth('switch', 'sw', 260, 48)).toBe(260)
    expect(equipmentHeight('switch', 'sw', 90)).toBe(90)
  })
})

describe('export crop', () => {
  it('crops to equipment and unwraps group-relative positions', () => {
    const boxes = absoluteExportBoxes([
      { id: 'room', type: 'groupFrame', position: { x: 0, y: 0 }, width: 2000, height: 1600 },
      {
        id: 'sw',
        type: 'equipment',
        parentNode: 'room',
        position: { x: 40, y: 60 },
        width: 176,
        height: 72,
      },
    ])
    expect(boxes).toHaveLength(1)
    expect(boxes[0].position).toEqual({ x: 40, y: 60 })
    const bounds = contentBounds(boxes, 20)
    expect(bounds.width).toBeLessThan(400)
    expect(bounds.height).toBeLessThan(200)
  })
})
