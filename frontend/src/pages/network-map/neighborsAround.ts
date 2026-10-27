import type { NetworkTopology, NetworkTopologyEdge, NetworkTopologyNode } from '../../api'
import { bindKey, parseTopologyId, type NetworkMapBind, type NetworkMapScene, type NetworkMapSceneNode } from './types'
import { stencilForDeviceType } from './mergeScene'

export const CLUSTER_RADIUS = 168
export const CLUSTER_SNAP = 20
export const GATHER_MIN_DIST = 220

export type NeighborOffer = {
  topoId: string
  label: string
  ip: string | null
  deviceType: string | null
  localPort: string | null
  remotePort: string | null
  linkType: string
  canvasId: string | null
}

export function snapCoord(value: number, grid = CLUSTER_SNAP): number {
  return Math.round(value / grid) * grid
}

export function neighborSlots(
  cx: number,
  cy: number,
  count: number,
  radius = CLUSTER_RADIUS,
  snap = CLUSTER_SNAP,
): Array<{ x: number; y: number }> {
  const n = Math.max(0, count)
  if (n === 0) return []
  const start = -Math.PI / 2
  return Array.from({ length: n }, (_, i) => {
    const angle = start + (i * 2 * Math.PI) / n
    return {
      x: snapCoord(cx + Math.cos(angle) * radius, snap),
      y: snapCoord(cy + Math.sin(angle) * radius, snap),
    }
  })
}

export function relatedNodeIds(edges: Array<{ source: string; target: string }>, selectedId: string | null): Set<string> {
  const out = new Set<string>()
  if (!selectedId) return out
  out.add(selectedId)
  for (const e of edges) {
    if (e.source === selectedId) out.add(e.target)
    if (e.target === selectedId) out.add(e.source)
  }
  return out
}

export function canvasIdForBind(nodes: NetworkMapSceneNode[], bind: NetworkMapBind): string | undefined {
  const key = bindKey(bind)
  return nodes.find((n) => n.bind && bindKey(n.bind) === key)?.id
}

export function offersFromTopology(
  selectedBind: NetworkMapBind | null | undefined,
  scene: NetworkMapScene,
  topo: NetworkTopology | null,
): NeighborOffer[] {
  if (!selectedBind || !topo) return []
  const selfId = bindKey(selectedBind)
  const byId = new Map(topo.nodes.map((n) => [n.id, n]))
  const hops: Array<{ peer: NetworkTopologyNode; edge: NetworkTopologyEdge; fromSelf: boolean }> = []
  for (const edge of topo.edges) {
    if (edge.source === selfId && edge.target !== selfId) {
      const peer = byId.get(edge.target)
      if (peer) hops.push({ peer, edge, fromSelf: true })
    } else if (edge.target === selfId && edge.source !== selfId) {
      const peer = byId.get(edge.source)
      if (peer) hops.push({ peer, edge, fromSelf: false })
    }
  }
  const seen = new Set<string>()
  const offers: NeighborOffer[] = []
  for (const hop of hops) {
    if (seen.has(hop.peer.id)) continue
    seen.add(hop.peer.id)
    const bind = parseTopologyId(hop.peer.id)
    offers.push({
      topoId: hop.peer.id,
      label: hop.peer.label || hop.peer.ip_address || hop.peer.id,
      ip: hop.peer.ip_address,
      deviceType: hop.peer.device_type,
      localPort: hop.fromSelf ? hop.edge.local_port : hop.edge.remote_port,
      remotePort: hop.fromSelf ? hop.edge.remote_port : hop.edge.local_port,
      linkType: hop.edge.link_type,
      canvasId: bind ? canvasIdForBind(scene.nodes, bind) || null : null,
    })
  }
  return offers
}

export function applyNeighborCluster(
  scene: NetworkMapScene,
  centerId: string,
  offers: NeighborOffer[],
  mode: 'place-missing' | 'gather-all',
): NetworkMapScene {
  const center = scene.nodes.find((n) => n.id === centerId)
  if (!center) return scene
  const work = offers.filter((o) => (mode === 'place-missing' ? !o.canvasId : true))
  if (!work.length) return scene
  const slots = neighborSlots(center.x, center.y, work.length)
  const nextNodes = [...scene.nodes]
  const nextEdges = [...scene.edges]
  const seenPairs = new Set(
    nextEdges.map((e) => (e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`)),
  )

  work.forEach((offer, idx) => {
    const slot = slots[idx]
    if (!slot) return
    let nodeId = offer.canvasId || nextNodes.find((n) => n.id === offer.topoId)?.id || null
    if (!nodeId) {
      const bind = parseTopologyId(offer.topoId)
      nodeId = offer.topoId
      nextNodes.push({
        id: nodeId,
        stencil: stencilForDeviceType(offer.deviceType),
        x: slot.x,
        y: slot.y,
        parentGroupId: center.parentGroupId ?? null,
        bind,
        label: offer.label,
      })
    } else {
      const existing = nextNodes.find((n) => n.id === nodeId)
      if (!existing) return
      const dx = existing.x - center.x
      const dy = existing.y - center.y
      const far = Math.hypot(dx, dy) >= GATHER_MIN_DIST
      if (mode === 'gather-all' || far) {
        existing.x = slot.x
        existing.y = slot.y
        existing.parentGroupId = center.parentGroupId ?? existing.parentGroupId
      }
    }
    const pair = centerId < nodeId ? `${centerId}|${nodeId}` : `${nodeId}|${centerId}`
    if (!seenPairs.has(pair)) {
      seenPairs.add(pair)
      nextEdges.push({
        id: `auto:${pair}`.slice(0, 120),
        source: centerId,
        target: nodeId,
        local_port: offer.localPort,
        remote_port: offer.remotePort,
      })
    }
  })

  return { ...scene, nodes: nextNodes, edges: nextEdges }
}
