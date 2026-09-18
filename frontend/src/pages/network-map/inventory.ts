import { stencilForDeviceType } from './mergeScene'
import { bindKey, type NetworkMapBind, type NetworkMapScene, type NetworkMapStencil } from './types'

export type TrayGear = {
  bind: NetworkMapBind
  label: string
  ip: string | null
  stencil: NetworkMapStencil
  deviceType: string | null
}

const SKIP_TYPES = new Set(['host', 'computer', 'pc', 'printer'])

export function ipv4Slash24(ip?: string | null): string | null {
  const raw = (ip || '').trim()
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw)
  if (!m) return null
  const parts = [m[1], m[2], m[3], m[4]].map(Number)
  if (parts.some((n) => n > 255)) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`
}

export function matchMapQuery(
  node: { id: string; label?: string | null; ip?: string | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return false
  return [node.label, node.ip, node.id].some((value) => (value || '').toLowerCase().includes(q))
}

export function subnetLayers(
  nodes: Array<{ ip?: string | null }>,
): Array<{ cidr: string; count: number }> {
  const counts = new Map<string, number>()
  for (const node of nodes) {
    const cidr = ipv4Slash24(node.ip)
    if (!cidr) continue
    counts.set(cidr, (counts.get(cidr) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cidr, count]) => ({ cidr, count }))
}

export function placedBindKeys(scene: NetworkMapScene): Set<string> {
  const keys = new Set<string>()
  for (const node of scene.nodes) {
    if (node.bind) keys.add(bindKey(node.bind))
  }
  return keys
}

export function gearNotOnMap(
  devices: Array<{
    id: number
    hostname?: string | null
    sys_name?: string | null
    ip_address?: string | null
    device_type?: string | null
  }>,
  scene: NetworkMapScene,
): TrayGear[] {
  const placed = placedBindKeys(scene)
  const out: TrayGear[] = []
  for (const device of devices) {
    const dtype = (device.device_type || '').toLowerCase()
    if (SKIP_TYPES.has(dtype)) continue
    const bind: NetworkMapBind = { type: 'network_device', id: device.id }
    if (placed.has(bindKey(bind))) continue
    const label = (device.hostname || device.sys_name || device.ip_address || `device ${device.id}`).trim()
    out.push({
      bind,
      label,
      ip: device.ip_address || null,
      stencil: stencilForDeviceType(dtype),
      deviceType: dtype || null,
    })
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

export function cloneScene(scene: NetworkMapScene): NetworkMapScene {
  return JSON.parse(JSON.stringify(scene)) as NetworkMapScene
}
