import { MarkerType, Position, type Edge, type Node } from 'reactflow'
import type { NetworkTopology, NetworkTopologyEdge, NetworkTopologyNode } from '../api'
import type { NetworkMapNodeData } from '../components/network/NetworkMapNode'

export const CORAX_NODE_ID = 'corax:self'

const COLLAPSE_AT = 5
const CORE_W = 196
const DEV_W = 168
const LEAF_W = 136
const CLUSTER_W = 148
const H_GAP = 28
const ROW_GAP = 22
const LAYER_GAP = 56
const PAD = 48
const MAX_COLS = 8

type Band = 0 | 1 | 2 | 3 | 4 | 5

function nodeType(n: NetworkTopologyNode): string {
  if (n.kind === 'corax' || n.id === CORAX_NODE_ID) return 'corax'
  if (n.kind === 'computer') return 'computer'
  if (n.kind === 'printer') return 'printer'
  const role = (n.role || '').toLowerCase()
  if (role === 'dns' || /^(dns|dns\s)/i.test(n.label || '')) return 'dns'
  if (role === 'gateway') return 'gateway'
  return (n.device_type || 'unknown').toLowerCase()
}

function bandOf(t: string): Band {
  if (t === 'corax') return 0
  if (t === 'router' || t === 'gateway' || t === 'firewall' || t === 'modem') return 1
  if (t === 'dns' || t === 'server' || t === 'nas' || t === 'controller' || t === 'infra') return 2
  if (t === 'switch') return 3
  if (t === 'computer' || t === 'host' || t === 'printer') return 5
  return 4
}

function packCols(count: number): number {
  if (count <= 1) return 1
  if (count <= 6) return count
  if (count <= 16) return 6
  return Math.min(MAX_COLS, Math.max(6, Math.ceil(Math.sqrt(count))))
}

function linkWeight(t: string): number {
  if (t === 'lldp' || t === 'cdp' || t === 'mndp' || t === 'ndp' || t === 'fdp' || t === 'edp' || t === 'isdp' || t === 'hndp') return 6
  if (t === 'trace') return 5
  if (t === 'lan') return 4
  if (t === 'fdb') return 3
  if (t === 'subnet') return 1
  return 2
}

function mapData(n: NetworkTopologyNode): NetworkMapNodeData {
  const t = nodeType(n)
  return {
    label: n.label,
    title: n.label,
    deviceType: t,
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
  if (count <= 0) return { w: 0, h: 0 }
  if (count > COLLAPSE_AT && !expanded) return { w: CLUSTER_W, h: 58 }
  const cols = Math.min(3, Math.max(1, count))
  const rows = Math.ceil(count / cols)
  return { w: cols * (LEAF_W + 12), h: 16 + rows * 86 }
}

function cellWidth(t: string): number {
  if (t === 'corax') return CORE_W
  if (bandOf(t) >= 5) return LEAF_W
  return DEV_W
}

function edgeCaption(e: NetworkTopologyEdge): string {
  if (e.link_type === 'lan') return ''
  if (e.link_type === 'trace') return 'трасса'
  if (e.link_type === 'subnet') return ''
  const port = [e.local_port, e.remote_port].filter(Boolean).join(' → ')
  if (port) return port
  if (e.link_type === 'lldp' || e.link_type === 'cdp') return e.link_type.toUpperCase()
  return ''
}

function styleLink(e: NetworkTopologyEdge): Pick<Edge, 'style' | 'animated' | 'label' | 'labelStyle' | 'markerEnd' | 'zIndex'> {
  const traced = e.link_type === 'trace'
  const lan = e.link_type === 'lan'
  const soft = e.link_type === 'subnet'
  const caption = edgeCaption(e)
  return {
    label: caption || undefined,
    labelStyle: { fontSize: 10, fill: traced ? '#6d28d9' : 'var(--color-fg-subtle)', fontWeight: traced ? 650 : 500 },
    markerEnd: { type: MarkerType.ArrowClosed, width: traced ? 14 : 11, height: traced ? 14 : 11 },
    animated: traced || e.link_type === 'lldp' || e.link_type === 'cdp',
    zIndex: traced ? 4 : lan ? 3 : soft ? 1 : 2,
    style: {
      stroke: traced ? '#7c3aed' : lan ? 'var(--color-fg-muted)' : soft ? 'var(--color-border-strong)' : 'var(--color-primary)',
      strokeWidth: traced ? 2.4 : lan ? 1.35 : soft ? 1 : 1.55,
      strokeDasharray: traced ? '0' : lan ? '5 4' : soft ? '4 5' : undefined,
      opacity: soft ? 0.35 : lan ? 0.7 : 1,
    },
  }
}

function ensureCorax(topo: NetworkTopology): NetworkTopology {
  if (topo.nodes.some((n) => n.kind === 'corax' || n.id === CORAX_NODE_ID)) return topo
  const cores = topo.nodes.filter((n) => n.kind === 'network_device' && bandOf(nodeType(n)) <= 2)
  const extra: NetworkTopologyEdge[] = cores.slice(0, 12).map((n, i) => ({
    id: `link:corax-local-${i}`,
    source: CORAX_NODE_ID,
    target: n.id,
    link_type: 'lan',
    local_port: null,
    remote_port: null,
    confidence: 0.4,
  }))
  return {
    nodes: [
      {
        id: CORAX_NODE_ID,
        kind: 'corax',
        ref_id: 0,
        label: 'Corax',
        device_type: 'corax',
        ip_address: null,
        vendor: 'CORAX',
        snmp_status: 'ok',
        role: 'corax',
      },
      ...topo.nodes,
    ],
    edges: [...extra, ...topo.edges],
  }
}

export function layoutTopology(
  raw: NetworkTopology,
  expandClusters: Set<string>,
): { nodes: Node<NetworkMapNodeData>[]; edges: Edge[] } {
  const topo = ensureCorax(raw)
  const byId = new Map(topo.nodes.map((n) => [n.id, n]))
  const devices = topo.nodes.filter((n) => n.kind === 'network_device' || n.kind === 'corax')
  const childrenOf = new Map<string, string[]>()
  const deviceEdges: NetworkTopologyEdge[] = []
  const adj = new Map<string, { id: string; weight: number }[]>()

  const addAdj = (a: string, b: string, weight: number) => {
    const list = adj.get(a) || []
    const prev = list.find((x) => x.id === b)
    if (prev) {
      if (weight > prev.weight) prev.weight = weight
      return
    }
    list.push({ id: b, weight })
    adj.set(a, list)
  }

  for (const e of topo.edges) {
    const a = byId.get(e.source)
    const b = byId.get(e.target)
    if (!a || !b) continue
    const aDev = a.kind === 'network_device' || a.kind === 'corax'
    const bDev = b.kind === 'network_device' || b.kind === 'corax'
    if (aDev && bDev) {
      deviceEdges.push(e)
      const w = linkWeight(e.link_type)
      addAdj(a.id, b.id, w)
      addAdj(b.id, a.id, w)
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
  const orphanHosts = topo.nodes.filter((n) => n.kind !== 'network_device' && n.kind !== 'corax' && !attached.has(n.id))

  const parentOf = new Map<string, string>()
  const seen = new Set<string>([CORAX_NODE_ID])
  const ordered = [...devices]
    .filter((d) => d.id !== CORAX_NODE_ID)
    .sort((a, b) => bandOf(nodeType(a)) - bandOf(nodeType(b)))

  for (const dev of ordered) {
    const rank = bandOf(nodeType(dev))
    let best: { id: string; weight: number; band: number } | null = null
    for (const nb of adj.get(dev.id) || []) {
      if (!seen.has(nb.id)) continue
      const other = byId.get(nb.id)
      if (!other) continue
      const ob = bandOf(nodeType(other))
      if (ob > rank) continue
      if (
        !best ||
        ob < best.band ||
        (ob === best.band && nb.weight > best.weight)
      ) {
        best = { id: nb.id, weight: nb.weight, band: ob }
      }
    }
    parentOf.set(dev.id, best?.id || CORAX_NODE_ID)
    seen.add(dev.id)
  }

  const treeKids = new Map<string, string[]>()
  for (const [child, par] of parentOf) {
    const list = treeKids.get(par) || []
    list.push(child)
    treeKids.set(par, list)
  }
  for (const kids of treeKids.values()) {
    kids.sort((a, b) => {
      const ba = bandOf(nodeType(byId.get(a)!))
      const bb = bandOf(nodeType(byId.get(b)!))
      if (ba !== bb) return ba - bb
      return (childrenOf.get(b)?.length || 0) - (childrenOf.get(a)?.length || 0)
    })
  }

  const bands: Record<1 | 2 | 3 | 4, string[]> = { 1: [], 2: [], 3: [], 4: [] }
  for (const id of treeKids.get(CORAX_NODE_ID) || []) {
    const b = bandOf(nodeType(byId.get(id)!))
    if (b === 0 || b === 5) continue
    bands[b].push(id)
  }
  const deeper = [...devices].filter((d) => d.id !== CORAX_NODE_ID && parentOf.get(d.id) !== CORAX_NODE_ID)
  for (const d of deeper) {
    const b = bandOf(nodeType(d))
    if (b === 1 || b === 2 || b === 3 || b === 4) {
      if (!bands[b].includes(d.id)) bands[b].push(d.id)
    }
  }

  const layerItems = [bands[1], bands[2], bands[3], bands[4]].filter((x) => x.length)
  const layerMetrics = layerItems.map((ids) => {
    const cols = packCols(ids.length)
    const widths = ids.map((id) => {
      const t = nodeType(byId.get(id)!)
      const leaf = leafFootprint(childrenOf.get(id)?.length || 0, expandClusters.has(id))
      return Math.max(cellWidth(t), leaf.w)
    })
    const colW = Math.max(DEV_W, ...widths.slice(0, cols), DEV_W)
    return { ids, cols, colW, rows: Math.ceil(ids.length / cols) }
  })

  const canvasW = Math.max(
    CORE_W,
    ...layerMetrics.map((m) => m.cols * m.colW + Math.max(0, m.cols - 1) * H_GAP),
  )

  const pos = new Map<string, { x: number; y: number }>()
  pos.set(CORAX_NODE_ID, { x: PAD + (canvasW - CORE_W) / 2, y: 28 })

  let y = 28 + 92 + LAYER_GAP
  for (const layer of layerMetrics) {
    const layerW = layer.cols * layer.colW + Math.max(0, layer.cols - 1) * H_GAP
    const left = PAD + (canvasW - layerW) / 2
    const rowLeafH: number[] = Array.from({ length: layer.rows }, () => 0)
    layer.ids.forEach((id, i) => {
      const row = Math.floor(i / layer.cols)
      const leaf = leafFootprint(childrenOf.get(id)?.length || 0, expandClusters.has(id))
      rowLeafH[row] = Math.max(rowLeafH[row], leaf.h)
    })
    const rowTop: number[] = []
    let acc = y
    for (let r = 0; r < layer.rows; r++) {
      rowTop[r] = acc
      acc += 72 + (rowLeafH[r] ? rowLeafH[r] + 10 : 0) + ROW_GAP
    }
    layer.ids.forEach((id, i) => {
      const col = i % layer.cols
      const row = Math.floor(i / layer.cols)
      const t = nodeType(byId.get(id)!)
      const w = cellWidth(t)
      pos.set(id, {
        x: left + col * (layer.colW + H_GAP) + (layer.colW - w) / 2,
        y: rowTop[row],
      })
    })
    y = acc + LAYER_GAP - ROW_GAP
  }

  const nodes: Node<NetworkMapNodeData>[] = []
  const edges: Edge[] = []

  for (const dev of devices) {
    const p = pos.get(dev.id)
    if (!p) continue
    const t = nodeType(dev)
    nodes.push({
      id: dev.id,
      type: 'topology',
      position: p,
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      data: mapData(dev),
      style: nodeStyle(cellWidth(t)),
    })
  }

  devices.forEach((dev) => {
    if (dev.kind === 'corax') return
    const p = pos.get(dev.id)
    if (!p) return
    const kids = childrenOf.get(dev.id) || []
    if (!kids.length) return
    const leafY = p.y + 78
    const expanded = expandClusters.has(dev.id)
    if (kids.length > COLLAPSE_AT && !expanded) {
      const clusterId = `cluster:${dev.id}`
      nodes.push({
        id: clusterId,
        type: 'topology',
        position: { x: p.x + (DEV_W - CLUSTER_W) / 2, y: leafY },
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
        style: nodeStyle(CLUSTER_W),
      })
      edges.push({
        id: `e-${dev.id}-cluster`,
        source: dev.id,
        target: clusterId,
        type: 'smoothstep',
        style: { stroke: 'var(--color-fg-subtle)', strokeWidth: 1.2, opacity: 0.65 },
      })
      return
    }
    const cols = Math.min(3, Math.max(1, kids.length))
    kids.forEach((cid, i) => {
      const child = byId.get(cid)
      if (!child) return
      const col = i % cols
      const row = Math.floor(i / cols)
      nodes.push({
        id: cid,
        type: 'topology',
        position: {
          x: p.x + (col - (cols - 1) / 2) * (LEAF_W + 12),
          y: leafY + row * 86,
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
        style: { stroke: 'var(--color-fg-subtle)', strokeWidth: 1.1, opacity: 0.65 },
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
    const bottom = y + 8
    const expanded = expandClusters.has('orphans')
    if (orphanHosts.length > COLLAPSE_AT && !expanded) {
      nodes.push({
        id: 'cluster:orphans',
        type: 'topology',
        position: { x: PAD + (canvasW - CLUSTER_W) / 2, y: bottom },
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
        style: nodeStyle(CLUSTER_W),
      })
    } else {
      const cols = packCols(orphanHosts.length)
      const gridW = cols * LEAF_W + Math.max(0, cols - 1) * 16
      const left = PAD + (canvasW - gridW) / 2
      orphanHosts.forEach((h, i) => {
        const col = i % cols
        const row = Math.floor(i / cols)
        nodes.push({
          id: h.id,
          type: 'topology',
          position: { x: left + col * (LEAF_W + 16), y: bottom + row * 86 },
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
    case 'corax':
      return '#111827'
    case 'router':
    case 'gateway':
      return '#7c3aed'
    case 'dns':
      return '#4f46e5'
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

export function layoutBounds(nodes: { position: { x: number; y: number } }[]): { width: number; height: number } {
  if (!nodes.length) return { width: 0, height: 0 }
  const xs = nodes.map((n) => n.position.x)
  const ys = nodes.map((n) => n.position.y)
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}
