import { describe, expect, it } from 'vitest'
import { emptyNetworkMapScene } from './types'
import { flattenSubnetGroups } from './flow'
import { gearNotOnMap, ipv4Slash24, matchMapQuery, subnetLayers } from './inventory'
import { createUndoStack } from './undo'

describe('ipv4Slash24', () => {
  it('groups a host into its /24', () => {
    expect(ipv4Slash24('10.0.0.12')).toBe('10.0.0.0/24')
    expect(ipv4Slash24('bad')).toBeNull()
  })
})

describe('matchMapQuery', () => {
  it('matches label or ip', () => {
    const node = { id: 'network_device:1', label: 'sw-core', ip: '10.1.0.10' }
    expect(matchMapQuery(node, 'CORE')).toBe(true)
    expect(matchMapQuery(node, '10.1.0')).toBe(true)
    expect(matchMapQuery(node, 'ap-1')).toBe(false)
  })
})

describe('gearNotOnMap', () => {
  it('skips hosts and already placed gear', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [
      {
        id: 'network_device:2',
        stencil: 'switch',
        x: 0,
        y: 0,
        bind: { type: 'network_device', id: 2 },
        label: 'sw',
      },
    ]
    const tray = gearNotOnMap(
      [
        { id: 1, hostname: 'gw', ip_address: '10.0.0.1', device_type: 'router' },
        { id: 2, hostname: 'sw', ip_address: '10.0.0.10', device_type: 'switch' },
        { id: 9, hostname: 'pc', ip_address: '10.0.0.40', device_type: 'host' },
      ],
      scene,
    )
    expect(tray.map((item) => item.bind.id)).toEqual([1])
    expect(tray[0].label).toBe('gw')
  })
})

describe('subnetLayers', () => {
  it('counts unique /24s', () => {
    const layers = subnetLayers([{ ip: '10.0.0.1' }, { ip: '10.0.0.8' }, { ip: '10.1.0.3' }])
    expect(layers).toEqual([
      { cidr: '10.0.0.0/24', count: 2 },
      { cidr: '10.1.0.0/24', count: 1 },
    ])
  })
})

describe('flattenSubnetGroups', () => {
  it('drops subnet frames and keeps room frames', () => {
    const scene = emptyNetworkMapScene()
    scene.groups = [
      { id: 'subnet:10.0.0.0/24', title: '10.0.0.0/24', kind: 'subnet', x: 80, y: 20, width: 400, height: 200, cidr: '10.0.0.0/24' },
      { id: 'room-1', title: 'Серверная', kind: 'room', x: 0, y: 0, width: 480, height: 300 },
    ]
    scene.nodes = [
      { id: 'sw', stencil: 'switch', x: 100, y: 60, parentGroupId: 'subnet:10.0.0.0/24', label: 'sw' },
      { id: 'fw', stencil: 'firewall', x: 40, y: 40, parentGroupId: 'room-1', label: 'fw' },
    ]
    const next = flattenSubnetGroups(scene)
    expect(next.groups.map((g) => g.id)).toEqual(['room-1'])
    expect(next.nodes[0].parentGroupId).toBeNull()
    expect(next.nodes[1].parentGroupId).toBe('room-1')
  })
})

describe('undo stack', () => {
  it('restores the previous scene', () => {
    const stack = createUndoStack()
    const a = emptyNetworkMapScene()
    const b = emptyNetworkMapScene()
    b.nodes = [{ id: 'sw', stencil: 'switch', x: 1, y: 2, label: 'sw' }]
    stack.push(a)
    const undone = stack.undo(b)
    expect(undone?.nodes).toEqual([])
    const redone = stack.redo(undone || a)
    expect(redone?.nodes[0].id).toBe('sw')
  })
})
