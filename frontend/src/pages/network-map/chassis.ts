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

export function chassisPortLayout(count: number): { cols: number; rows: number } {
  const n = Math.max(0, Math.min(MAX_CHASSIS_PORTS, Math.floor(count)))
  if (n <= 0) return { cols: 0, rows: 0 }
  if (n <= 24) return { cols: n, rows: 1 }
  return { cols: Math.ceil(n / 2), rows: 2 }
}

export function chassisPorts(
  live: Array<{ id: string; name: string; up?: boolean | null }> | null | undefined,
  count?: number | null,
): Array<{ id: string; name: string; up?: boolean | null }> {
  const named: Array<{ id: string; name: string; up?: boolean | null }> = []
  const seen = new Set<string>()
  for (const port of live || []) {
    const name = (port.name || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    named.push({ id: port.id || name, name, up: port.up })
    if (named.length >= MAX_CHASSIS_PORTS) break
  }
  const n = count != null && count > 0 ? Math.min(MAX_CHASSIS_PORTS, Math.floor(count)) : named.length
  if (n <= 0) return []
  const out = named.slice(0, n)
  for (let i = out.length + 1; i <= n; i += 1) {
    out.push({ id: `slot:${i}`, name: String(i) })
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
  if (n > 0) {
    const { cols } = chassisPortLayout(n)
    const computed = Math.max(148, Math.min(760, 32 + cols * 16))
    if (width && width > 0) return Math.max(width, computed)
    return computed
  }
  if (width && width > 0) return Math.max(80, Math.min(1600, width))
  return 112
}

export function equipmentHeight(stencil: string, label = '', height?: number | null, portCount?: number | null): number {
  if (stencil === 'note') {
    if (height && height > 0) return Math.max(48, Math.min(1200, height))
    return Math.max(36, Math.min(240, label.split('\n').length * 28 + 8))
  }
  if (stencil === 'image') return height && height > 0 ? Math.max(48, Math.min(1200, height)) : 140
  const n = Number(portCount || 0)
  if (n > 0) {
    const { rows } = chassisPortLayout(n)
    const computed = 78 + rows * 18
    if (height && height > 0) return Math.max(height, computed)
    return computed
  }
  if (height && height > 0) return Math.max(48, Math.min(1200, height))
  if (stencil === 'switch' && label.length > 18) return 96
  return 90
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
