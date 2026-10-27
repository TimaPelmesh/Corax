import type {
  HydratedMap,
  MapLiveItem,
  MergedCanvasEdge,
  MergedCanvasNode,
  NetworkMapBind,
  NetworkMapBindType,
  NetworkMapScene,
  NetworkMapStencil,
} from './types'
import { bindKey, emptyNetworkMapScene } from './types'
import { sanitizeCablePoints } from './cables'
import { chassisPorts, defaultStencilPortCount } from './chassis'

export function stencilForDeviceType(deviceType?: string | null): NetworkMapStencil {
  const dtype = (deviceType || '').toLowerCase()
  if (dtype === 'gateway' || dtype === 'router' || dtype === 'modem') return 'router'
  if (dtype === 'firewall') return 'firewall'
  if (dtype === 'ap') return 'ap'
  if (dtype === 'nas') return 'nas'
  if (dtype === 'server') return 'server'
  if (dtype === 'switch' || dtype === 'controller') return 'switch'
  if (dtype === 'printer') return 'printer'
  if (dtype === 'computer' || dtype === 'pc' || dtype === 'host') return 'pc'
  if (dtype === 'vm') return 'vm'
  return 'unknown'
}

export function stencilForBind(type: NetworkMapBindType, deviceType?: string | null): NetworkMapStencil {
  if (type === 'printer') return 'printer'
  if (type === 'computer') return 'pc'
  if (type === 'corax') return 'corax'
  if (type === 'zabbix') return stencilForDeviceType(deviceType) === 'unknown' ? 'server' : stencilForDeviceType(deviceType)
  return stencilForDeviceType(deviceType)
}

export function deviceTypeForStencil(stencil: NetworkMapStencil): string | null {
  if (stencil === 'router') return 'router'
  if (stencil === 'switch') return 'switch'
  if (stencil === 'ap') return 'ap'
  if (stencil === 'firewall') return 'firewall'
  if (stencil === 'server') return 'server'
  if (stencil === 'nas') return 'nas'
  if (stencil === 'printer') return 'printer'
  if (stencil === 'pc') return 'host'
  if (stencil === 'vm') return 'vm'
  if (stencil === 'unknown') return 'unknown'
  return null
}

function liveMap(items: MapLiveItem[]): Map<string, MapLiveItem> {
  const out = new Map<string, MapLiveItem>()
  for (const item of items) {
    out.set(bindKey({ type: item.type, id: item.id }), item)
  }
  return out
}

function cablePortPins(edges: Array<{ source: string; target: string; local_port?: string | null; remote_port?: string | null }>): Map<string, string[]> {
  const pins = new Map<string, string[]>()
  const add = (id: string, port?: string | null) => {
    const name = (port || '').trim()
    if (!id || !name) return
    const list = pins.get(id) || []
    list.push(name)
    pins.set(id, list)
  }
  for (const edge of edges) {
    add(edge.source, edge.local_port)
    add(edge.target, edge.remote_port)
  }
  return pins
}

export function hydrateScene(scene: NetworkMapScene | null | undefined, live: MapLiveItem[] = []): HydratedMap {
  const base = scene ?? emptyNetworkMapScene()
  const liveByKey = liveMap(live)
  const pins = cablePortPins(base.edges)
  const nodes: MergedCanvasNode[] = base.nodes.map((sn) => {
    const bind = sn.bind ?? null
    const liveHit = bind ? liveByKey.get(bindKey(bind)) : undefined
    return {
      id: sn.id,
      stencil: sn.stencil,
      x: sn.x,
      y: sn.y,
      parentGroupId: sn.parentGroupId ?? null,
      bind,
      label: liveHit?.label || sn.label || sn.id,
      ip: liveHit?.ip ?? null,
      vendor: liveHit?.vendor ?? null,
      status: liveHit?.status ?? null,
      kind: bind?.type || (sn.stencil === 'note' || sn.stencil === 'image' ? sn.stencil : 'logical'),
      missing: liveHit ? liveHit.missing : false,
      imageSrc: sn.imageSrc ?? null,
      width: sn.width ?? null,
      height: sn.height ?? null,
      ports: chassisPorts(liveHit?.ports, sn.portCount ?? defaultStencilPortCount(sn.stencil), pins.get(sn.id)),
      portCount: sn.portCount ?? null,
      locked: Boolean(sn.locked) || undefined,
    }
  })
  const placed = new Set(nodes.map((n) => n.id))
  const edges: MergedCanvasEdge[] = []
  const seen = new Set<string>()
  for (const e of base.edges) {
    if (!placed.has(e.source) || !placed.has(e.target) || e.source === e.target) continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      linkType: e.link_type || 'manual',
      localPort: e.local_port ?? null,
      remotePort: e.remote_port ?? null,
      persisted: false,
      linkDbId: null,
      points: sanitizeCablePoints(e.points),
    })
  }
  return { groups: base.groups, nodes, edges }
}

export function sceneFromHydrate(result: HydratedMap, previous?: NetworkMapScene | null): NetworkMapScene {
  return {
    version: 1,
    groups: result.groups,
    nodes: result.nodes.map((n) => ({
      id: n.id,
      stencil: n.stencil,
      x: n.x,
      y: n.y,
      parentGroupId: n.parentGroupId ?? null,
      bind: n.bind ?? null,
      label: n.label,
      imageSrc: n.imageSrc ?? null,
      width: n.width ?? null,
      height: n.height ?? null,
      portCount: n.portCount ?? null,
      locked: n.locked || undefined,
    })),
    edges: result.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      local_port: e.localPort ?? null,
      remote_port: e.remotePort ?? null,
      link_type: e.linkType || 'manual',
      points: sanitizeCablePoints(e.points),
    })),
    hiddenNodeIds: previous?.hiddenNodeIds ?? [],
    viewport: previous?.viewport ?? null,
  }
}

export function overlayLiveOnMerged(
  nodes: MergedCanvasNode[],
  live: MapLiveItem[],
  edges: Array<{ source: string; target: string; local_port?: string | null; remote_port?: string | null }> = [],
): MergedCanvasNode[] {
  const liveByKey = liveMap(live)
  const pins = cablePortPins(edges)
  return nodes.map((n) => {
    const hit = n.bind ? liveByKey.get(bindKey(n.bind)) : undefined
    if (!hit) return n
    return {
      ...n,
      label: hit.label || n.label,
      ip: hit.ip ?? n.ip,
      vendor: hit.vendor ?? n.vendor,
      status: hit.status ?? n.status,
      missing: hit.missing,
      ports: chassisPorts(hit.ports, n.portCount ?? defaultStencilPortCount(n.stencil), pins.get(n.id)),
      portCount: n.portCount ?? null,
    }
  })
}

export function bindsFromScene(scene: NetworkMapScene): NetworkMapBind[] {
  const out: NetworkMapBind[] = []
  const seen = new Set<string>()
  for (const n of scene.nodes) {
    if (!n.bind) continue
    const key = bindKey(n.bind)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n.bind)
  }
  return out
}
