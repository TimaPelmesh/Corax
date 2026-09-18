import { describe, expect, it } from 'vitest'
import {
  collectScene,
  equipmentHeight,
  equipmentWidth,
  releaseNodeFromGroup,
  toFlowEdges,
  toFlowNodes,
  toWorldScene,
  viewportFlowCenter,
  worldPosition,
} from './flow'
import { absoluteExportBoxes, contentBounds } from './cables'
import { emptyNetworkMapScene } from './types'

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

describe('free group membership', () => {
  const groups = [
    { id: 'room-1', title: 'Серверная', kind: 'room' as const, x: 80, y: 220, width: 400, height: 280 },
  ]

  it('lifts old relative coords into world space once', () => {
    expect(worldPosition({ x: 24, y: 48, parentGroupId: 'room-1' }, groups)).toEqual({ x: 104, y: 268 })
    expect(worldPosition({ x: 104, y: 268, parentGroupId: 'room-1' }, groups)).toEqual({ x: 104, y: 268 })
  })

  it('does not parent equipment in React Flow', () => {
    const rf = toFlowNodes(groups, [
      {
        id: 'sw',
        stencil: 'switch',
        x: 24,
        y: 48,
        parentGroupId: 'room-1',
        label: 'sw',
        kind: 'network_device',
        missing: false,
      },
    ])
    const sw = rf.find((n) => n.id === 'sw')
    expect(sw?.parentNode).toBeUndefined()
    expect(sw?.extent).toBeUndefined()
    expect(sw?.position).toEqual({ x: 104, y: 268 })
    expect((sw?.data as { parentGroupId?: string }).parentGroupId).toBe('room-1')
  })

  it('keeps room membership after collect and drops it when dragged outside', () => {
    const scene = toWorldScene({
      ...emptyNetworkMapScene(),
      groups,
      nodes: [
        {
          id: 'sw',
          stencil: 'switch',
          x: 24,
          y: 48,
          parentGroupId: 'room-1',
          label: 'sw',
        },
      ],
    })
    const rf = toFlowNodes(scene.groups, [
      {
        id: 'sw',
        stencil: 'switch',
        x: scene.nodes[0].x,
        y: scene.nodes[0].y,
        parentGroupId: 'room-1',
        label: 'sw',
        kind: 'network_device',
        missing: false,
      },
    ])
    const collected = collectScene(rf, [], scene, { x: 0, y: 0, zoom: 1 })
    expect(collected.nodes[0].parentGroupId).toBe('room-1')
    expect(collected.nodes[0].x).toBe(104)
    const outside = {
      ...collected,
      nodes: collected.nodes.map((n) => ({ ...n, x: 900, y: 40 })),
    }
    expect(releaseNodeFromGroup(outside, 'sw').nodes[0].parentGroupId).toBeNull()
    expect(releaseNodeFromGroup(collected, 'sw').nodes[0].parentGroupId).toBe('room-1')
  })
})

describe('collapsed subnet edges', () => {
  it('rewrites cables onto the group while the subnet is folded', () => {
    const edges = toFlowEdges(
      [{ id: 'e1', source: 'sw', target: 'gw', linkType: 'subnet', persisted: false }],
      [{ id: 'subnet:10.0.0.0/24', title: '10.0.0.0/24', kind: 'subnet', x: 0, y: 0, width: 400, height: 280, collapsed: true }],
      [
        {
          id: 'sw',
          stencil: 'switch',
          x: 20,
          y: 40,
          parentGroupId: 'subnet:10.0.0.0/24',
          label: 'sw',
          kind: 'network_device',
          missing: false,
        },
        { id: 'gw', stencil: 'router', x: 80, y: 20, label: 'gw', kind: 'network_device', missing: false },
      ],
    )
    expect(edges).toHaveLength(1)
    expect(edges[0].source).toBe('subnet:10.0.0.0/24')
    expect(edges[0].target).toBe('gw')
  })
})

describe('cable signal', () => {
  const sw = {
    id: 'sw',
    stencil: 'switch' as const,
    x: 0,
    y: 0,
    label: 'sw',
    kind: 'network_device',
    missing: false,
    status: 'ok',
  }
  const ap = {
    id: 'ap',
    stencil: 'ap' as const,
    x: 80,
    y: 0,
    label: 'ap',
    kind: 'network_device',
    missing: false,
    status: 'ok',
  }

  it('animates a live neighbor cable', () => {
    const edges = toFlowEdges([{ id: 'e1', source: 'sw', target: 'ap', linkType: 'lldp', persisted: true }], [], [sw, ap])
    expect((edges[0].data as { signal?: boolean }).signal).toBe(true)
  })

  it('does not animate logical or down cables', () => {
    const lan = toFlowEdges([{ id: 'e1', source: 'sw', target: 'ap', linkType: 'lan', persisted: false }], [], [sw, ap])
    expect((lan[0].data as { signal?: boolean }).signal).toBe(false)
    const down = toFlowEdges(
      [{ id: 'e1', source: 'sw', target: 'ap', linkType: 'lldp', persisted: true }],
      [],
      [sw, { ...ap, status: 'error' }],
    )
    expect((down[0].data as { signal?: boolean }).signal).toBe(false)
  })
})

describe('export crop', () => {
  it('crops to equipment and unwraps group-relative positions', () => {
    const boxes = absoluteExportBoxes([
      { id: 'room', type: 'groupFrame', position: { x: 0, y: 0 }, width: 2000, height: 1600 },
      {
        id: 'sw',
        type: 'equipment',
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
