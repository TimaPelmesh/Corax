import { describe, expect, it } from 'vitest'
import type { NetworkTopology } from '../api'
import { layoutTopology } from './networkMapLayout'

function sampleTopo(): NetworkTopology {
  return {
    nodes: [
      {
        id: 'network_device:1',
        kind: 'network_device',
        ref_id: 1,
        label: 'gw-core',
        device_type: 'router',
        ip_address: '192.168.1.1',
        vendor: 'Cisco',
        snmp_status: 'ok',
      },
      {
        id: 'network_device:2',
        kind: 'network_device',
        ref_id: 2,
        label: 'sw-access',
        device_type: 'switch',
        ip_address: '192.168.1.10',
        vendor: 'Cisco',
        snmp_status: 'ok',
      },
      {
        id: 'computer:1',
        kind: 'computer',
        ref_id: 1,
        label: 'pc-01',
        device_type: 'computer',
        ip_address: '192.168.1.50',
        vendor: null,
        snmp_status: 'online',
      },
    ],
    edges: [
      {
        id: 'link:1',
        source: 'network_device:1',
        target: 'network_device:2',
        link_type: 'trace',
        local_port: null,
        remote_port: null,
        confidence: 0.62,
      },
      {
        id: 'link:2',
        source: 'network_device:2',
        target: 'computer:1',
        link_type: 'fdb',
        local_port: 'Gi1/0/8',
        remote_port: null,
        confidence: 0.75,
      },
    ],
  }
}

describe('layoutTopology', () => {
  it('places routers above switches and keeps PCs as separate nodes', () => {
    const { nodes, edges } = layoutTopology(sampleTopo(), new Set())
    const router = nodes.find((n) => n.id === 'network_device:1')
    const sw = nodes.find((n) => n.id === 'network_device:2')
    const pc = nodes.find((n) => n.id === 'computer:1')
    expect(router?.position.y).toBeLessThan(sw?.position.y ?? 9999)
    expect(pc).toBeTruthy()
    expect(pc?.data.deviceType).toBe('computer')
    expect(edges.some((e) => e.source === 'network_device:1' && e.target === 'network_device:2')).toBe(true)
    const trace = edges.find((e) => e.source === 'network_device:1' && e.target === 'network_device:2')
    expect(trace?.type).toBe('smoothstep')
    expect(String(trace?.style?.stroke)).toContain('7c3aed')
    expect(trace?.label).toBe('трасса')
  })
})
