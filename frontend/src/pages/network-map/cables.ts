export type CablePoint = { x: number; y: number }

export function sanitizeCablePoints(raw: unknown, limit = 8): CablePoint[] {
  if (!Array.isArray(raw)) return []
  const out: CablePoint[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const x = Number((item as { x?: unknown }).x)
    const y = Number((item as { y?: unknown }).y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ x, y })
    if (out.length >= limit) break
  }
  return out
}

/** Rounded polyline through source, user bends, and target. */
export function cableBendPath(points: CablePoint[], radius = 14): { d: string; labelX: number; labelY: number } {
  if (points.length < 2) return { d: '', labelX: 0, labelY: 0 }
  if (points.length === 2) {
    const [a, b] = points
    return {
      d: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
      labelX: (a.x + b.x) / 2,
      labelY: (a.y + b.y) / 2,
    }
  }
  const r = Math.max(2, radius)
  let d = `M ${points[0].x} ${points[0].y}`
  for (let i = 1; i < points.length - 1; i += 1) {
    const prev = points[i - 1]
    const curr = points[i]
    const next = points[i + 1]
    const inX = curr.x - prev.x
    const inY = curr.y - prev.y
    const outX = next.x - curr.x
    const outY = next.y - curr.y
    const inLen = Math.hypot(inX, inY) || 1
    const outLen = Math.hypot(outX, outY) || 1
    const rad = Math.min(r, inLen / 2, outLen / 2)
    d += ` L ${curr.x - (inX / inLen) * rad} ${curr.y - (inY / inLen) * rad}`
    d += ` Q ${curr.x} ${curr.y} ${curr.x + (outX / outLen) * rad} ${curr.y + (outY / outLen) * rad}`
  }
  const last = points[points.length - 1]
  d += ` L ${last.x} ${last.y}`
  const midA = points[Math.floor((points.length - 1) / 2)]
  const midB = points[Math.ceil((points.length - 1) / 2)]
  return { d, labelX: (midA.x + midB.x) / 2, labelY: (midA.y + midB.y) / 2 }
}

export function usedPortsForNode(
  edges: Array<{
    id?: string
    source: string
    target: string
    local_port?: string | null
    remote_port?: string | null
    localPort?: string | null
    remotePort?: string | null
  }>,
  nodeId: string,
  skipEdgeId?: string | null,
): Set<string> {
  const used = new Set<string>()
  for (const edge of edges) {
    if (skipEdgeId && edge.id === skipEdgeId) continue
    const local = edge.local_port ?? edge.localPort ?? null
    const remote = edge.remote_port ?? edge.remotePort ?? null
    if (edge.source === nodeId && local) used.add(local)
    if (edge.target === nodeId && remote) used.add(remote)
  }
  return used
}

export function pairKey(source: string, target: string): string {
  return source < target ? `${source}|${target}` : `${target}|${source}`
}

/** Spread parallel cables so traces do not sit on the same path. */
export function laneForEdges<T extends { id: string; source: string; target: string }>(edges: T[]): Map<string, number> {
  const groups = new Map<string, T[]>()
  for (const edge of edges) {
    const key = pairKey(edge.source, edge.target)
    const list = groups.get(key)
    if (list) list.push(edge)
    else groups.set(key, [edge])
  }
  const lanes = new Map<string, number>()
  for (const list of groups.values()) {
    list.forEach((edge, index) => {
      const centered = index - (list.length - 1) / 2
      lanes.set(edge.id, centered)
    })
  }
  return lanes
}

export function contentBounds(
  nodes: Array<{ position: { x: number; y: number }; width?: number | null; height?: number | null; style?: { width?: number | string; height?: number | string } }>,
  pad = 48,
): { x: number; y: number; width: number; height: number } {
  if (!nodes.length) return { x: 0, y: 0, width: 1200, height: 800 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const w = Number(node.width || node.style?.width || 176)
    const h = Number(node.height || node.style?.height || 80)
    const x = Number(node.position?.x)
    const y = Number(node.position?.y)
    if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(x) || !Number.isFinite(y)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 1200, height: 800 }
  }
  return {
    x: minX - pad,
    y: minY - pad,
    width: Math.max(160, maxX - minX + pad * 2),
    height: Math.max(100, maxY - minY + pad * 2),
  }
}

export function absoluteExportBoxes(
  nodes: Array<{
    id: string
    type?: string
    parentNode?: string
    hidden?: boolean
    position: { x: number; y: number }
    positionAbsolute?: { x: number; y: number }
    width?: number | null
    height?: number | null
    style?: { width?: number | string; height?: number | string }
  }>,
): Array<{ position: { x: number; y: number }; width: number; height: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const abs = (node: (typeof nodes)[number]): { x: number; y: number } => {
    if (node.positionAbsolute) return node.positionAbsolute
    let x = node.position.x
    let y = node.position.y
    let parentId = node.parentNode
    const seen = new Set<string>([node.id])
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      x += parent.position.x
      y += parent.position.y
      parentId = parent.parentNode
    }
    return { x, y }
  }
  const visible = nodes.filter((n) => n.hidden !== true)
  const gear = visible.filter((n) => n.type === 'equipment')
  const source = gear.length ? gear : visible.filter((n) => n.type === 'groupFrame')
  return source.map((n) => ({
    position: abs(n),
    width: Number(n.width || n.style?.width || 176),
    height: Number(n.height || n.style?.height || 72),
  }))
}

export function exportPixelSize(
  bounds: { width: number; height: number },
  pixelRatio = 3,
  maxSide = 8192,
): { width: number; height: number; ratio: number } {
  const ratio = Math.min(pixelRatio, maxSide / Math.max(1, bounds.width), maxSide / Math.max(1, bounds.height))
  return {
    width: Math.max(1, Math.round(bounds.width * ratio)),
    height: Math.max(1, Math.round(bounds.height * ratio)),
    ratio,
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function transformForBounds(
  bounds: { x: number; y: number; width: number; height: number },
  width: number,
  height: number,
): { x: number; y: number; zoom: number } {
  const zoom = Math.min(width / Math.max(1, bounds.width), height / Math.max(1, bounds.height))
  return {
    x: -bounds.x * zoom,
    y: -bounds.y * zoom,
    zoom,
  }
}

export function safeFilename(title: string): string {
  const slug = title.trim().replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, '-').slice(0, 80)
  return slug || 'network-map'
}
