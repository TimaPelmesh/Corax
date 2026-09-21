import { describe, expect, it } from 'vitest'
import {
  collectScene,
  decorateSelection,
  equipmentHeight,
  equipmentWidth,
  followPackLeader,
  isMultiSelectEvent,
  nextCanvasPackIds,
  addToCanvasPack,
  portsForPicker,
  releaseNodeFromGroup,
  applySceneFrameMembership,
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

  it('nests a dropped node into the room under it', () => {
    const scene = {
      ...emptyNetworkMapScene(),
      groups,
      nodes: [{ id: 'sw', stencil: 'switch' as const, x: 120, y: 260, label: 'sw' }],
    }
    expect(applySceneFrameMembership(scene, 'sw').nodes[0].parentGroupId).toBe('room-1')
    const outside = {
      ...scene,
      nodes: [{ id: 'sw', stencil: 'switch' as const, x: 900, y: 40, label: 'sw' }],
    }
    expect(applySceneFrameMembership(outside, 'sw').nodes[0].parentGroupId).toBeNull()
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

describe('portsForPicker', () => {
  it('keeps a short unique list of named ports', () => {
    expect(
      portsForPicker([
        { id: '1', name: 'Gi1/0/1', up: true },
        { id: '2', name: 'Gi1/0/1', up: false },
        { id: '3', name: '  ' },
        { id: '4', name: 'Gi1/0/2' },
      ]),
    ).toEqual([
      { id: '1', name: 'Gi1/0/1', up: true },
      { id: '4', name: 'Gi1/0/2', up: undefined },
    ])
  })
})

describe('decorateSelection', () => {
  it('keeps equipment selected after a click so jacks stay interactive', () => {
    const nodes = [
      { id: 'sw', type: 'equipment', position: { x: 0, y: 0 }, data: { stencil: 'switch', title: 'sw' }, selected: false },
      { id: 'fw', type: 'equipment', position: { x: 80, y: 0 }, data: { stencil: 'firewall', title: 'fw' }, selected: true },
    ]
    const out = decorateSelection(nodes, [], ['sw'])
    expect(out.nodes.find((n) => n.id === 'sw')?.selected).toBe(true)
    expect(out.nodes.find((n) => n.id === 'fw')?.selected).toBe(false)
  })

  it('clears selection when nothing is picked', () => {
    const nodes = [
      { id: 'sw', type: 'equipment', position: { x: 0, y: 0 }, data: { stencil: 'switch', title: 'sw' }, selected: true },
    ]
    const out = decorateSelection(nodes, [], [])
    expect(out.nodes[0].selected).toBe(false)
  })

  it('marks every shift-selected node', () => {
    const nodes = [
      { id: 'sw', type: 'equipment', position: { x: 0, y: 0 }, data: { stencil: 'switch', title: 'sw' } },
      { id: 'fw', type: 'equipment', position: { x: 80, y: 0 }, data: { stencil: 'firewall', title: 'fw' } },
    ]
    const out = decorateSelection(nodes, [], ['sw', 'fw'])
    expect(out.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(['sw', 'fw'])
    expect(out.nodes.every((n) => n.className?.includes('is-pack-selected'))).toBe(true)
    expect(out.nodes.every((n) => (n.data as { selected?: boolean }).selected)).toBe(true)
  })

  it('highlights a selected cable without selecting nodes', () => {
    const nodes = [
      { id: 'sw', type: 'equipment', position: { x: 0, y: 0 }, data: { stencil: 'switch', title: 'sw' } },
      { id: 'fw', type: 'equipment', position: { x: 80, y: 0 }, data: { stencil: 'firewall', title: 'fw' } },
    ]
    const edges = [{ id: 'e1', source: 'sw', target: 'fw', sourceHandle: 'p:Gi1', targetHandle: 'p:Gi2' }]
    const out = decorateSelection(nodes, edges, [], null, 'e1')
    expect(out.nodes.every((n) => n.selected)).toBe(false)
    expect(out.nodes.every((n) => (n.data as { neighbor?: boolean }).neighbor)).toBe(true)
    expect(out.edges[0].selected).toBe(true)
    expect(out.edges[0].className).toContain('is-cable-selected')
  })
})

describe('canvas pack helpers', () => {
  it('treats Shift and Ctrl as additive modifiers', () => {
    expect(isMultiSelectEvent({ shiftKey: true })).toBe(true)
    expect(isMultiSelectEvent({ ctrlKey: true })).toBe(true)
    expect(isMultiSelectEvent({ metaKey: true })).toBe(true)
    expect(isMultiSelectEvent({ shiftKey: true, ctrlKey: true })).toBe(true)
    expect(isMultiSelectEvent({})).toBe(false)
  })

  it('adds ids to the pack without toggling them off', () => {
    expect(addToCanvasPack(['sw'], 'fw')).toEqual(['sw', 'fw'])
    expect(addToCanvasPack(['sw', 'fw'], 'fw')).toEqual(['sw', 'fw'])
  })

  it('can still replace or toggle a pack in isolation', () => {
    expect(nextCanvasPackIds(['sw'], 'fw', true)).toEqual(['sw', 'fw'])
    expect(nextCanvasPackIds(['sw', 'fw'], 'fw', true)).toEqual(['sw'])
    expect(nextCanvasPackIds(['sw', 'fw'], 'ap', false)).toEqual(['ap'])
  })

  it('moves every pack member with the leader', () => {
    const moved = followPackLeader(
      [
        { id: 'sw', x: 10, y: 20 },
        { id: 'fw', x: 40, y: 80 },
      ],
      { x: 10, y: 20 },
      { id: 'sw', x: 30, y: 50 },
    )
    expect(moved).toEqual([
      { id: 'sw', x: 30, y: 50 },
      { id: 'fw', x: 60, y: 110 },
    ])
  })
})

describe('collectScene cables', () => {
  const sw = {
    id: 'sw',
    stencil: 'switch' as const,
    x: 0,
    y: 0,
    label: 'sw',
    kind: 'network_device' as const,
    missing: false,
  }
  const ap = {
    id: 'ap',
    stencil: 'ap' as const,
    x: 80,
    y: 0,
    label: 'ap',
    kind: 'network_device' as const,
    missing: false,
  }

  it('does not resurrect a cable removed from the canvas', () => {
    const previous = {
      ...emptyNetworkMapScene(),
      nodes: [
        { id: 'sw', stencil: 'switch' as const, x: 0, y: 0, label: 'sw' },
        { id: 'ap', stencil: 'ap' as const, x: 80, y: 0, label: 'ap' },
      ],
      edges: [{ id: 'e1', source: 'sw', target: 'ap', link_type: 'manual', local_port: 'Gi1', remote_port: 'Gi2' }],
    }
    const collected = collectScene(toFlowNodes([], [sw, ap]), [], previous, { x: 0, y: 0, zoom: 1 })
    expect(collected.edges).toEqual([])
  })

  it('keeps a cable that is only visible on a collapsed group', () => {
    const groups = [
      { id: 'subnet:10.0.0.0/24', title: '10.0.0.0/24', kind: 'subnet' as const, x: 0, y: 0, width: 400, height: 280, collapsed: true },
    ]
    const members = [
      { ...sw, parentGroupId: 'subnet:10.0.0.0/24' },
      { id: 'gw', stencil: 'router' as const, x: 80, y: 20, label: 'gw', kind: 'network_device' as const, missing: false },
    ]
    const previous = {
      ...emptyNetworkMapScene(),
      groups,
      nodes: [
        { id: 'sw', stencil: 'switch' as const, x: 0, y: 0, parentGroupId: 'subnet:10.0.0.0/24', label: 'sw' },
        { id: 'gw', stencil: 'router' as const, x: 80, y: 20, label: 'gw' },
      ],
      edges: [{ id: 'e1', source: 'sw', target: 'gw', link_type: 'manual' }],
    }
    const rfEdges = toFlowEdges(
      [{ id: 'e1', source: 'sw', target: 'gw', linkType: 'manual', persisted: false }],
      groups,
      members,
    )
    const collected = collectScene(toFlowNodes(groups, members), rfEdges, previous, { x: 0, y: 0, zoom: 1 })
    expect(collected.edges.map((e) => e.id)).toEqual(['e1'])
    expect(collected.edges[0]).toMatchObject({ source: 'sw', target: 'gw' })
  })

  it('drops a collapsed-group cable after it is deleted on the canvas', () => {
    const groups = [
      { id: 'subnet:10.0.0.0/24', title: '10.0.0.0/24', kind: 'subnet' as const, x: 0, y: 0, width: 400, height: 280, collapsed: true },
    ]
    const members = [
      { ...sw, parentGroupId: 'subnet:10.0.0.0/24' },
      { id: 'gw', stencil: 'router' as const, x: 80, y: 20, label: 'gw', kind: 'network_device' as const, missing: false },
    ]
    const previous = {
      ...emptyNetworkMapScene(),
      groups,
      nodes: [
        { id: 'sw', stencil: 'switch' as const, x: 0, y: 0, parentGroupId: 'subnet:10.0.0.0/24', label: 'sw' },
        { id: 'gw', stencil: 'router' as const, x: 80, y: 20, label: 'gw' },
      ],
      edges: [{ id: 'e1', source: 'sw', target: 'gw', link_type: 'manual' }],
    }
    const collected = collectScene(toFlowNodes(groups, members), [], previous, { x: 0, y: 0, zoom: 1 })
    expect(collected.edges).toEqual([])
  })
})
