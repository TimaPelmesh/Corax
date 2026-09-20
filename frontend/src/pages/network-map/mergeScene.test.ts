import { describe, expect, it } from 'vitest'
import { bindsFromScene, deviceTypeForStencil, hydrateScene } from './mergeScene'
import { emptyNetworkMapScene } from './types'

describe('hydrateScene', () => {
  it('keeps an empty scene empty', () => {
    const hydrated = hydrateScene(emptyNetworkMapScene(), [
      { type: 'network_device', id: 1, label: 'sw-core', ip: '10.0.0.1', status: 'ok', missing: false },
    ])
    expect(hydrated.nodes).toHaveLength(0)
    expect(hydrated.edges).toHaveLength(0)
  })

  it('keeps saved positions and overlays live status', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [
      {
        id: 'logical:core',
        stencil: 'switch',
        x: 120,
        y: 80,
        bind: { type: 'network_device', id: 1 },
        label: 'sw-core',
      },
    ]
    scene.edges = [{ id: 'e1', source: 'logical:core', target: 'missing' }]
    const hydrated = hydrateScene(scene, [
      { type: 'network_device', id: 1, label: 'sw-core', ip: '10.0.0.1', vendor: 'Cisco', status: 'ok', missing: false },
    ])
    expect(hydrated.nodes).toHaveLength(1)
    expect(hydrated.nodes[0].x).toBe(120)
    expect(hydrated.nodes[0].status).toBe('ok')
    expect(hydrated.nodes[0].ip).toBe('10.0.0.1')
    expect(hydrated.edges).toHaveLength(0)
    expect(bindsFromScene(scene)).toEqual([{ type: 'network_device', id: 1 }])
  })

  it('marks missing binds without shifting the node', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [
      {
        id: 'logical-core',
        stencil: 'server',
        x: 300,
        y: 40,
        bind: { type: 'zabbix', id: 99 },
        label: 'old-srv',
      },
    ]
    const hydrated = hydrateScene(scene, [{ type: 'zabbix', id: 99, missing: true }])
    const ghost = hydrated.nodes.find((n) => n.id === 'logical-core')
    expect(ghost?.missing).toBe(true)
    expect(ghost?.x).toBe(300)
    expect(ghost?.label).toBe('old-srv')
  })

  it('keeps captions and images without live overlay', () => {
    const scene = emptyNetworkMapScene()
    scene.nodes = [
      { id: 'logical:note', stencil: 'note', x: 8, y: 12, label: 'DMZ' },
      {
        id: 'logical:logo',
        stencil: 'image',
        x: 40,
        y: 20,
        label: 'logo',
        imageSrc: 'data:image/png;base64,aaa',
        width: 180,
        height: 60,
      },
    ]
    const hydrated = hydrateScene(scene)
    expect(hydrated.nodes).toHaveLength(2)
    expect(hydrated.nodes[0].kind).toBe('note')
    expect(hydrated.nodes[1].imageSrc).toBe('data:image/png;base64,aaa')
    expect(hydrated.nodes[1].width).toBe(180)
  })
})

describe('deviceTypeForStencil', () => {
  it('maps canvas stencils to stored network types', () => {
    expect(deviceTypeForStencil('switch')).toBe('switch')
    expect(deviceTypeForStencil('ap')).toBe('ap')
    expect(deviceTypeForStencil('pc')).toBe('host')
    expect(deviceTypeForStencil('note')).toBeNull()
    expect(deviceTypeForStencil('corax')).toBeNull()
  })
})
