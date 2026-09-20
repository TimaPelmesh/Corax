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
