import { MarkerType, Position, type Edge, type Node } from 'reactflow'
import type { NetworkTopology, NetworkTopologyEdge, NetworkTopologyNode } from '../api'
import type { NetworkMapNodeData } from '../components/network/NetworkMapNode'

const COLLAPSE_AT = 6
const DEV_W = 188
const LEAF_W = 148
const LEVEL_Y = 176
const TREE_GAP = 56
const LEAF_COLS = 2
const LEAF_DX = 158
const LEAF_DY = 94
const FOREST_GAP = 88

function nodeType(n: NetworkTopologyNode): string {
  if (n.kind === 'computer') return 'computer'
  if (n.kind === 'printer') return 'printer'
  return (n.device_type || 'unknown').toLowerCase()
}

function isCoreType(t: string): boolean {
  return t === 'router' || t === 'gateway' || t === 'firewall' || t === 'modem'
}

function typeRank(t: string): number {
  if (isCoreType(t)) return 0
  if (t === 'controller' || t === 'switch') return 1
  if (t === 'ap' || t === 'server' || t === 'nas') return 2
  if (t === 'computer' || t === 'host' || t === 'printer') return 4
  return 3
}

function linkWeight(t: string): number {
  if (t === 'lldp' || t === 'cdp') return 6
  if (t === 'trace') return 5
  if (t === 'fdb') return 3
  if (t === 'subnet') return 1
  return 2
}

function mapData(n: NetworkTopologyNode): NetworkMapNodeData {
  return {
    label: n.label,
    title: n.label,
    deviceType: nodeType(n),
    kind: n.kind,
    ip: n.ip_address,
    vendor: n.vendor,
    status: n.snmp_status,
  }
}

function nodeStyle(width: number): Node<NetworkMapNodeData>['style'] {
  return { width, padding: 0, border: 'none', background: 'transparent', boxShadow: 'none' }
}

function leafFootprint(count: number, expanded: boolean): { w: number; h: number } {
  if (count <= 0) return { w: DEV_W, h: 0 }
  if (count > COLLAPSE_AT && !expanded) return { w: Math.max(DEV_W, 168), h: 64 }
  const cols = Math.min(LEAF_COLS, Math.max(1, count))
  const rows = Math.ceil(count / cols)
  return { w: Math.max(DEV_W, cols * LEAF_DX), h: 20 + rows * LEAF_DY }
}

function edgeCaption(e: NetworkTopologyEdge): string {
  if (e.link_type === 'trace') return 'трасса'
  if (e.link_type === 'subnet') return ''
  const port = [e.local_port, e.remote_port].filter(Boolean).join(' → ')
  if (port) return port
  if (e.link_type === 'lldp' || e.link_type === 'cdp') return e.link_type.toUpperCase()
  return ''
}

function styleLink(e: NetworkTopologyEdge): Pick<Edge, 'style' | 'animated' | 'label' | 'labelStyle' | 'markerEnd' | 'zIndex'> {
  const traced = e.link_type === 'trace'
  const soft = e.link_type === 'subnet'
  const caption = edgeCaption(e)
  return {
    label: caption || undefined,
    labelStyle: { fontSize: 10, fill: traced ? '#6d28d9' : 'var(--color-fg-subtle)', fontWeight: traced ? 650 : 500 },
    markerEnd: { type: MarkerType.ArrowClosed, width: traced ? 14 : 11, height: traced ? 14 : 11 },
    animated: traced || e.link_type === 'lldp' || e.link_type === 'cdp',
    zIndex: traced ? 4 : soft ? 1 : 2,
    style: {
      stroke: traced ? '#7c3aed' : soft ? 'var(--color-border-strong)' : 'var(--color-primary)',
      strokeWidth: traced ? 2.4 : soft ? 1 : 1.55,
      strokeDasharray: traced ? '0' : soft ? '4 5' : undefined,
      opacity: soft ? 0.4 : 1,
    },
  }
}

export function layoutTopology(
  topo: NetworkTopology,
  expandClusters: Set<string>,
): { nodes: Node<NetworkMapNodeData>[]; edges: Edge[] } {
  const byId = new Map(topo.nodes.map((n) => [n.id, n]))
  const devices = topo.nodes.filter((n) => n.kind === 'network_device')
  const childrenOf = new Map<string, string[]>()
  const deviceEdges: NetworkTopologyEdge[] = []
  const adj = new Map<string, { id: string; weight: number; type: string }[]>()
  const degree = new Map<string, number>()

  const addAdj = (a: string, b: string, weight: number, type: string) => {
    const list = adj.get(a) || []
    const prev = list.find((x) => x.id === b)
    if (prev) {
      if (weight > prev.weight) {
        prev.weight = weight
        prev.type = type
      }
      return
    }
    list.push({ id: b, weight, type })
    adj.set(a, list)
  }

  for (const e of topo.edges) {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    degree.set(e.source, (degree.get(e.source) || 0) + 1)
    degree.set(e.target, (degree.get(e.target) || 0) + 1)
    const aDev = a.kind === 'network_device'
    const bDev = b.kind === 'network_device'
    if (aDev && bDev) {
      deviceEdges.push(e)
      const w = linkWeight(e.link_type)
      addAdj(a.id, b.id, w, e.link_type)
      addAdj(b.id, a.id, w, e.link_type)
      continue
    }
    const parent = aDev ? a.id : bDev ? b.id : null
    const child = aDev ? b.id : bDev ? a.id : null
    if (parent && child) {
      const list = childrenOf.get(parent) || []
      if (!list.includes(child)) list.push(child)
      childrenOf.set(parent, list)
    }
  }

  const attached = new Set([...childrenOf.values()].flat())
  const orphanHosts = topo.nodes.filter((n) => n.kind !== 'network_device' && !attached.has(n.id))

  const parentOf = new Map<string, string>()
  const ordered = [...devices].sort((a, b) => {
    const ra = typeRank(nodeType(a))
    const rb = typeRank(nodeType(b))
    if (ra !== rb) return ra - rb
    return (degree.get(b.id) || 0) - (degree.get(a.id) || 0)
  })
  const seen = new Set<string>()
  const roots: NetworkTopologyNode[] = []

  for (const dev of ordered) {
    if (seen.has(dev.id)) continue
    const rank = typeRank(nodeType(dev))
    let best: { id: string; weight: number } | null = null
    for (const nb of adj.get(dev.id) || []) {
      if (!seen.has(nb.id)) continue
      const other = byId.get(nb.id)
      if (!other) continue
      const or = typeRank(nodeType(other))
      if (or > rank) continue
      if (!best || nb.weight > best.weight || (nb.weight === best.weight && or < typeRank(nodeType(byId.get(best.id)!)))) {
        best = { id: nb.id, weight: nb.weight }
      }
    }
    if (best) parentOf.set(dev.id, best.id)
    else roots.push(dev)
    seen.add(dev.id)
  }
  for (const dev of devices) {
    if (!seen.has(dev.id)) {
      roots.push(dev)
      seen.add(dev.id)
    }
  }
  if (!roots.length && devices.length) roots.push(ordered[0])

  const treeKids = new Map<string, string[]>()
  for (const [child, par] of parentOf) {
    const list = treeKids.get(par) || []
    list.push(child)
    treeKids.set(par, list)
  }
  for (const kids of treeKids.values()) {
    kids.sort((a, b) => {
      const na = byId.get(a)
      const nb = byId.get(b)
      const ra = na ? typeRank(nodeType(na)) : 9
      const rb = nb ? typeRank(nodeType(nb)) : 9
      if (ra !== rb) return ra - rb
      return (degree.get(b) || 0) - (degree.get(a) || 0)
    })
  }

  const sizeCache = new Map<string, { w: number; h: number }>()
  const subtreeSize = (id: string): { w: number; h: number } => {
    const hit = sizeCache.get(id)
    if (hit) return hit
    const kids = treeKids.get(id) || []
    const leaf = leafFootprint(childrenOf.get(id)?.length || 0, expandClusters.has(id))
    if (!kids.length) {
      const size = { w: Math.max(DEV_W, leaf.w), h: leaf.h }
      sizeCache.set(id, size)
      return size
    }
    const parts = kids.map(subtreeSize)
    const kidsW = parts.reduce((s, p) => s + p.w, 0) + TREE_GAP * (kids.length - 1)
    const size = {
      w: Math.max(DEV_W, leaf.w, kidsW),
      h: LEVEL_Y + Math.max(...parts.map((p) => p.h)) + leaf.h,
    }
    sizeCache.set(id, size)
    return size
  }

  const pos = new Map<string, { x: number; y: number }>()
  const place = (id: string, left: number, top: number) => {
    const size = subtreeSize(id)
    pos.set(id, { x: left + size.w / 2 - DEV_W / 2, y: top })
    const kids = treeKids.get(id) || []
    if (!kids.length) return
    const parts = kids.map(subtreeSize)
    const kidsW = parts.reduce((s, p) => s + p.w, 0) + TREE_GAP * (kids.length - 1)
    let x = left + Math.max(0, (size.w - kidsW) / 2)
    kids.forEach((cid, i) => {
      place(cid, x, top + LEVEL_Y)
      x += parts[i].w + TREE_GAP
    })
  }

  let forestX = 48
  for (const root of roots) {
    const sz = subtreeSize(root.id)
    place(root.id, forestX, 36)
    forestX += sz.w + FOREST_GAP
  }

  const nodes: Node<NetworkMapNodeData>[] = []
  const edges: Edge[] = []

  for (const dev of devices) {
    const p = pos.get(dev.id) || { x: 48, y: 36 }
    nodes.push({
      id: dev.id,
      type: 'topology',
      position: p,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: mapData(dev),
      style: nodeStyle(DEV_W),
    })
  }

  devices.forEach((dev) => {
    const p = pos.get(dev.id) || { x: 80, y: 40 }
    const kids = childrenOf.get(dev.id) || []
    const treeBelow = treeKids.get(dev.id) || []
    const belowH = treeBelow.length ? Math.max(...treeBelow.map((id) => subtreeSize(id).h), 0) : 0
    const leafY = p.y + (treeBelow.length ? LEVEL_Y + belowH + 12 : 108)
    const expanded = expandClusters.has(dev.id)
    if (kids.length > COLLAPSE_AT && !expanded) {
      const clusterId = `cluster:${dev.id}`
      nodes.push({
        id: clusterId,
        type: 'topology',
        position: { x: p.x + 10, y: leafY },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          label: `ПК · ${kids.length}`,
          title: `ПК · ${kids.length}`,
          deviceType: 'computer',
          kind: 'cluster',
          clusterOf: dev.id,
          count: kids.length,
        },
        style: nodeStyle(168),
      })
      edges.push({
        id: `e-${dev.id}-cluster`,
        source: dev.id,
        target: clusterId,
        type: 'smoothstep',
        style: { stroke: 'var(--color-primary)', strokeWidth: 1.4, opacity: 0.75 },
      })
      return
    }
    const cols = Math.min(LEAF_COLS, Math.max(1, kids.length))
    kids.forEach((cid, i) => {
      const child = byId.get(cid)
      if (!child) return
      const col = i % cols
      const row = Math.floor(i / cols)
      nodes.push({
        id: cid,
        type: 'topology',
        position: {
          x: p.x + (col - (cols - 1) / 2) * LEAF_DX,
          y: leafY + row * LEAF_DY,
        },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: mapData(child),
        style: nodeStyle(LEAF_W),
      })
      edges.push({
        id: `e-${dev.id}-${cid}`,
        source: dev.id,
        target: cid,
        type: 'smoothstep',
        style: { stroke: 'var(--color-fg-subtle)', strokeWidth: 1.15, opacity: 0.7 },
      })
    })
  })

  const stronger = new Set<string>()
  for (const e of deviceEdges) {
    if (e.link_type === 'subnet') continue
    stronger.add([e.source, e.target].sort().join('|'))
  }
  for (const e of deviceEdges) {
    if (e.link_type === 'subnet' && stronger.has([e.source, e.target].sort().join('|'))) continue
    edges.push({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'smoothstep',
      ...styleLink(e),
    })
  }

  if (orphanHosts.length) {
    const expanded = expandClusters.has('orphans')
    if (orphanHosts.length > COLLAPSE_AT && !expanded) {
      nodes.push({
        id: 'cluster:orphans',
        type: 'topology',
        position: { x: forestX, y: 36 },
        sourcePosition: Position.Bottom,
        targetPosition: Position.Top,
        data: {
          label: `ПК · ${orphanHosts.length}`,
          title: `ПК · ${orphanHosts.length}`,
          deviceType: 'computer',
          kind: 'cluster',
          clusterOf: 'orphans',
          count: orphanHosts.length,
        },
        style: nodeStyle(168),
      })
    } else {
      const startX = forestX
      const startY = 36
      orphanHosts.forEach((h, i) => {
        const col = i % 4
        const row = Math.floor(i / 4)
        nodes.push({
          id: h.id,
          type: 'topology',
          position: { x: startX + col * LEAF_DX, y: startY + row * LEAF_DY },
          sourcePosition: Position.Bottom,
          targetPosition: Position.Top,
          data: mapData(h),
          style: nodeStyle(LEAF_W),
        })
      })
    }
  }

  return { nodes, edges }
}

export function mapNodeColor(deviceType: string | undefined): string {
  switch (deviceType) {
    case 'router':
    case 'gateway':
      return '#7c3aed'
    case 'switch':
    case 'controller':
      return '#0284c7'
    case 'ap':
      return '#0d9488'
    case 'firewall':
      return '#d97706'
    case 'computer':
    case 'host':
      return '#64748b'
    case 'printer':
      return '#e11d48'
    default:
      return '#94a3b8'
  }
}
