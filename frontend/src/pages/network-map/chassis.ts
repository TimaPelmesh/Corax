import type { NetworkMapScene, NetworkMapStencil } from './types'

export const MAX_CHASSIS_PORTS = 96
export const DIAGRAM_GAP = 36
export const ROOM_PAD = 48
export const ROOM_SIZE = { width: 560, height: 380 } as const
export const RACK_SIZE = { width: 320, height: 520 } as const

export function portHandleId(name: string | null | undefined): string | undefined {
  const raw = (name || '').trim()
  if (!raw) return undefined
  const slug = raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return slug ? `p:${slug}` : undefined
}

/** Target jack id. Source and target handles cannot share one id, or the cable leaves the socket after a redraw. */
export function targetPortHandleId(name: string | null | undefined): string | undefined {
  const id = portHandleId(name)
  return id ? `${id}-tgt` : undefined
}

export function chassisPortLayout(count: number): { cols: number; rows: number } {
  const n = Math.max(0, Math.min(MAX_CHASSIS_PORTS, Math.floor(count)))
  if (n <= 0) return { cols: 0, rows: 0 }
  if (n <= 24) return { cols: n, rows: 1 }
  return { cols: Math.ceil(n / 2), rows: 2 }
}

export function chassisPorts(
  live: Array<{ id: string; name: string; up?: boolean | null }> | null | undefined,
  count?: number | null,
  pinned?: Array<string | null | undefined> | null,
): Array<{ id: string; name: string; up?: boolean | null }> {
  const liveByName = new Map<string, { id: string; name: string; up?: boolean | null }>()
  for (const port of live || []) {
    const name = (port.name || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (liveByName.has(key)) continue
    liveByName.set(key, { id: port.id || name, name, up: port.up })
  }
  const requested = count != null && count > 0 ? Math.min(MAX_CHASSIS_PORTS, Math.floor(count)) : 0
  const out: Array<{ id: string; name: string; up?: boolean | null }> = []
  const seen = new Set<string>()
  for (let i = 1; i <= requested; i += 1) {
    const name = String(i)
    const key = name.toLowerCase()
    seen.add(key)
    const hit = liveByName.get(key)
    out.push({ id: hit?.id || `slot:${i}`, name, up: hit?.up })
  }
  for (const raw of pinned || []) {
    const name = (raw || '').trim()
    if (!name || out.length >= MAX_CHASSIS_PORTS) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const hit = liveByName.get(key)
    out.push({ id: hit?.id || `pin:${name}`, name, up: hit?.up })
  }
  return out
}

export function defaultStencilPortCount(stencil: string): number | null {
  switch (stencil as NetworkMapStencil) {
    case 'switch':
      return 24
    case 'router':
    case 'firewall':
    case 'corax':
      return 8
    case 'server':
    case 'nas':
    case 'unknown':
      return 4
    case 'ap':
      return 2
    case 'pc':
    case 'printer':
      return 1
    case 'vm':
      return 2
    default:
      return null
  }
}

export function clampPortCount(value: unknown): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.max(1, Math.min(MAX_CHASSIS_PORTS, Math.round(n)))
}

export const GEAR_HEAD = 58
export const PORT_CELL = 14
export const PORT_ROW = 18
export const PORT_PAD_X = 10
export const PORT_PAD_Y = 8

export function equipmentWidth(
  stencil: string,
  label = '',
  width?: number | null,
  portCount?: number | null,
): number {
  if (stencil === 'note') {
    if (width && width > 0) return Math.max(80, Math.min(1600, width))
    const longest = label.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
    return Math.max(96, Math.min(420, longest * 11 + 20))
  }
  if (stencil === 'image') return width && width > 0 ? Math.max(80, Math.min(1600, width)) : 220
  const n = Number(portCount || 0)
  const count = n > 0 ? n : (defaultStencilPortCount(stencil) ?? 0)
  const { cols } = chassisPortLayout(count)
  const computed = count > 0 ? Math.max(108, Math.min(760, PORT_PAD_X * 2 + cols * PORT_CELL)) : 108
  if (width && width > computed) return Math.max(80, Math.min(1600, width))
  return computed
}

export function equipmentHeight(
  stencil: string,
  label = '',
  height?: number | null,
  portCount?: number | null,
): number {
  if (stencil === 'note') {
    if (height && height > 0) return Math.max(48, Math.min(1200, height))
    return Math.max(36, Math.min(240, label.split('\n').length * 28 + 8))
  }
  if (stencil === 'image') return height && height > 0 ? Math.max(48, Math.min(1200, height)) : 140
  const n = Number(portCount || 0)
  const count = n > 0 ? n : (defaultStencilPortCount(stencil) ?? 0)
  const rows = count > 0 ? chassisPortLayout(count).rows : 0
  const computed = GEAR_HEAD + (rows > 0 ? PORT_PAD_Y + rows * PORT_ROW : 6)
  if (height && height > computed) return Math.max(48, Math.min(1200, height))
  return computed
}

type Box = { x: number; y: number; width: number; height: number }

function overlaps(a: Box, b: Box, gap: number): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  )
}

export function nextDiagramSlot(
  occupied: Box[],
  pos: { x: number; y: number },
  size: { width: number; height: number },
  gap = DIAGRAM_GAP,
): { x: number; y: number } {
  let x = pos.x
  let y = pos.y
  let col = 0
  for (let i = 0; i < 48; i += 1) {
    const box = { x, y, width: size.width, height: size.height }
    if (!occupied.some((b) => overlaps(box, b, gap))) return { x, y }
    col += 1
    x += size.width + gap
    if (col >= 4) {
      col = 0
      x = pos.x
      y += size.height + gap
    }
  }
  return pos
}

export function occupiedBoxes(scene: NetworkMapScene): Box[] {
  const boxes: Box[] = scene.groups
    .filter((g) => g.kind === 'room' || g.kind === 'rack')
    .map((g) => ({ x: g.x, y: g.y, width: g.width, height: g.height }))
  for (const n of scene.nodes) {
    boxes.push({
      x: n.x,
      y: n.y,
      width: equipmentWidth(n.stencil, n.label || '', n.width, n.portCount),
      height: equipmentHeight(n.stencil, n.label || '', n.height, n.portCount),
    })
  }
  return boxes
}

const MAGNET_REACH = 36

/** Pull gear onto a shared column in a rack, or against a neighbour in a room. */
export function magnetInFrame(
  pos: { x: number; y: number },
  size: { width: number; height: number },
  frame: { x: number; y: number; width: number; height: number; kind: 'room' | 'rack' },
  siblings: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number } {
  const pad = frame.kind === 'rack' ? 28 : 40
  let x = pos.x
  let y = pos.y
  if (frame.kind === 'rack') {
    x = frame.x + pad
    const gap = 12
    let best: { y: number; d: number } | null = null
    for (const sibling of siblings) {
      for (const candidate of [sibling.y, sibling.y + sibling.height + gap, sibling.y - size.height - gap]) {
        const distance = Math.abs(pos.y - candidate)
        if (distance <= 56 && (!best || distance < best.d)) best = { y: candidate, d: distance }
      }
    }
    if (best) y = best.y
  } else {
    let bestX: { x: number; d: number } | null = null
    let bestY: { y: number; d: number } | null = null
    for (const sibling of siblings) {
      const nearRow = Math.abs(pos.y + size.height / 2 - (sibling.y + sibling.height / 2)) < size.height + MAGNET_REACH
      const nearCol = Math.abs(pos.x + size.width / 2 - (sibling.x + sibling.width / 2)) < size.width + MAGNET_REACH
      if (nearRow) {
        for (const candidate of [sibling.x, sibling.x + sibling.width + 16, sibling.x - size.width - 16]) {
          const distance = Math.abs(pos.x - candidate)
          if (distance <= MAGNET_REACH && (!bestX || distance < bestX.d)) bestX = { x: candidate, d: distance }
        }
      }
      if (nearCol) {
        for (const candidate of [sibling.y, sibling.y + sibling.height + 16, sibling.y - size.height - 16]) {
          const distance = Math.abs(pos.y - candidate)
          if (distance <= MAGNET_REACH && (!bestY || distance < bestY.d)) bestY = { y: candidate, d: distance }
        }
      }
    }
    if (bestX) x = bestX.x
    if (bestY) y = bestY.y
  }
  const minX = frame.x + 8
  const minY = frame.y + 28
  const maxX = Math.max(minX, frame.x + frame.width - size.width - 8)
  const maxY = Math.max(minY, frame.y + frame.height - size.height - 8)
  return {
    x: Math.round(Math.min(maxX, Math.max(minX, x))),
    y: Math.round(Math.min(maxY, Math.max(minY, y))),
  }
}

/** Free cell inside a room/rack so gear does not sit on top of each other. */
export function nextSlotInGroup(
  scene: NetworkMapScene,
  groupId: string,
  size: { width: number; height: number },
  origin: { x: number; y: number },
): { x: number; y: number } {
  const group = scene.groups.find((g) => g.id === groupId)
  if (!group) return origin
  const pad = group.kind === 'rack' ? 36 : ROOM_PAD
  const gap = 24
  const originX = group.x + pad
  const originY = group.y + pad + 22
  const innerW = Math.max(size.width, group.width - pad * 2)
  const cols = Math.max(1, Math.floor((innerW + gap) / (size.width + gap)))
  const members = scene.nodes.filter((n) => n.parentGroupId === groupId)
  const occupied = members.map((n) => ({
    x: n.x,
    y: n.y,
    width: equipmentWidth(n.stencil, n.label || '', n.width, n.portCount),
    height: equipmentHeight(n.stencil, n.label || '', n.height, n.portCount),
  }))
  for (let i = 0; i < 64; i += 1) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = originX + col * (size.width + gap)
    const y = originY + row * (size.height + gap)
    if (x + size.width > group.x + group.width - pad / 2) continue
    if (y + size.height > group.y + group.height - pad / 2) break
    const box = { x, y, width: size.width, height: size.height }
    if (!occupied.some((b) => overlaps(box, b, 8))) return { x, y }
  }
  return origin
}
