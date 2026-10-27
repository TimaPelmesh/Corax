import { describe, expect, it } from 'vitest'
import { applyNeighborCluster, neighborSlots, offersFromTopology, relatedNodeIds } from './neighborsAround'
import { emptyNetworkMapScene } from './types'

describe('neighborSlots', () => {
  it('places neighbors in a ring around the center', () => {
    const slots = neighborSlots(100, 80, 4, 100, 20)
    expect(slots).toHaveLength(4)
    const dists = slots.map((s) => Math.hypot(s.x - 100, s.y - 80))
    expect(Math.min(...dists)).toBeGreaterThan(80)
    expect(Math.max(...dists)).toBeLessThan(120)
  })
})

describe('relatedNodeIds', () => {
  it('includes the selected node and one hop', () => {
    const ids = relatedNodeIds(
      [
        { source: 'a', target: 'b' },
        { source: 'c', target: 'd' },
      ],
      'a',
    )
    expect([...ids].sort()).toEqual(['a', 'b'])
  })
})

describe('applyNeighborCluster', () => {
  it('places missing neighbors around the selected node and draws a link', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [{ id: 'sw', stencil: 'switch', x: 200, y: 120, bind: { type: 'network_device', id: 1 }, label: 'core' }]
    const next = applyNeighborCluster(
      scene,
      'sw',
      [
        {
          topoId: 'network_device:2',
          label: 'ap-1',
          ip: '10.0.0.2',
          deviceType: 'ap',
          localPort: 'Gi1/0/1',
          remotePort: 'eth0',
          linkType: 'lldp',
          canvasId: null,
        },
      ],
      'place-missing',
    )
    expect(next.nodes).toHaveLength(2)
    const ap = next.nodes.find((n) => n.id === 'network_device:2')
    expect(ap?.bind).toEqual({ type: 'network_device', id: 2 })
    expect(Math.hypot((ap?.x || 0) - 200, (ap?.y || 0) - 120)).toBeGreaterThan(80)
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0].local_port).toBe('Gi1/0/1')
  })

  it('pulls a far neighbor next to the selected node', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [
      { id: 'sw', stencil: 'switch', x: 0, y: 0, bind: { type: 'network_device', id: 1 }, label: 'core' },
      { id: 'ap', stencil: 'ap', x: 900, y: 700, bind: { type: 'network_device', id: 2 }, label: 'ap-1' },
    ]
    const next = applyNeighborCluster(
      scene,
      'sw',
      [
        {
          topoId: 'network_device:2',
          label: 'ap-1',
          ip: null,
          deviceType: 'ap',
          localPort: null,
          remotePort: null,
          linkType: 'lldp',
          canvasId: 'ap',
        },
      ],
      'gather-all',
    )
    const ap = next.nodes.find((n) => n.id === 'ap')
    expect(Math.hypot(ap?.x || 0, ap?.y || 0)).toBeLessThan(220)
  })
})

describe('offersFromTopology', () => {
  it('matches canvas nodes by bind and lists missing peers', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [{ id: 'logical:sw', stencil: 'switch', x: 0, y: 0, bind: { type: 'network_device', id: 1 }, label: 'core' }]
    const offers = offersFromTopology({ type: 'network_device', id: 1 }, scene, {
      nodes: [
        { id: 'network_device:1', kind: 'network_device', ref_id: 1, label: 'core', device_type: 'switch', ip_address: '10.0.0.1', vendor: null, snmp_status: 'ok' },
        { id: 'network_device:2', kind: 'network_device', ref_id: 2, label: 'ap-1', device_type: 'ap', ip_address: '10.0.0.2', vendor: null, snmp_status: 'ok' },
      ],
      edges: [
        { id: 'e1', source: 'network_device:1', target: 'network_device:2', link_type: 'lldp', local_port: 'Gi1', remote_port: 'eth0', confidence: 1 },
      ],
    })
    expect(offers).toHaveLength(1)
    expect(offers[0].label).toBe('ap-1')
    expect(offers[0].canvasId).toBeNull()
    expect(offers[0].localPort).toBe('Gi1')
  })
})
