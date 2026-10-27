export const NETWORK_MAP_SCENE_VERSION = 1 as const

export type NetworkMapStencil =
  | 'switch'
  | 'router'
  | 'firewall'
  | 'ap'
  | 'server'
  | 'nas'
  | 'pc'
  | 'vm'
  | 'printer'
  | 'cloud'
  | 'corax'
  | 'unknown'
  | 'note'
  | 'image'

export type NetworkMapBindType = 'network_device' | 'computer' | 'printer' | 'corax' | 'zabbix'

export type NetworkMapGroupKind = 'room' | 'rack' | 'subnet'

export type NetworkMapBind = {
  type: NetworkMapBindType
  id: number
}

export const NETWORK_MAP_DND = 'application/corax-network-map'

export type PaletteDrag =
  | { kind: 'stencil'; stencil: NetworkMapStencil }
  | { kind: 'group'; groupKind: 'room' | 'rack' }
  | { kind: 'inventory'; bind: NetworkMapBind; label: string; ip?: string | null; stencil: NetworkMapStencil }

export type NetworkMapSceneNode = {
  id: string
  stencil: NetworkMapStencil
  x: number
  y: number
  parentGroupId?: string | null
  bind?: NetworkMapBind | null
  label?: string | null
  imageSrc?: string | null
  width?: number | null
  height?: number | null
  portCount?: number | null
  locked?: boolean
}

export type NetworkMapGroup = {
  id: string
  title: string
  kind: NetworkMapGroupKind
  x: number
  y: number
  width: number
  height: number
  collapsed?: boolean
  cidr?: string | null
  locked?: boolean
}

export type NetworkMapSceneEdge = {
  id: string
  source: string
  target: string
  local_port?: string | null
  remote_port?: string | null
  link_type?: string | null
  points?: Array<{ x: number; y: number }> | null
}

export type NetworkMapViewport = {
  x: number
  y: number
  zoom: number
}

export type NetworkMapScene = {
  version: typeof NETWORK_MAP_SCENE_VERSION
  groups: NetworkMapGroup[]
  nodes: NetworkMapSceneNode[]
  edges: NetworkMapSceneEdge[]
  hiddenNodeIds: string[]
  viewport?: NetworkMapViewport | null
}

export type MergedCanvasNode = {
  id: string
  stencil: NetworkMapStencil
  x: number
  y: number
  parentGroupId?: string | null
  bind?: NetworkMapBind | null
  label: string
  ip?: string | null
  vendor?: string | null
  status?: string | null
  kind: string
  missing: boolean
  imageSrc?: string | null
  width?: number | null
  height?: number | null
  ports?: Array<{ id: string; name: string; up?: boolean | null }>
  portCount?: number | null
  locked?: boolean
}

export type MergedCanvasEdge = {
  id: string
  source: string
  target: string
  linkType: string
  localPort?: string | null
  remotePort?: string | null
  persisted: boolean
  linkDbId?: number | null
  points?: Array<{ x: number; y: number }>
}

export type MapLiveItem = {
  type: NetworkMapBindType
  id: number
  label?: string | null
  ip?: string | null
  vendor?: string | null
  status?: string | null
  missing: boolean
  portCount?: number | null
  ports?: Array<{ id: string; name: string; up?: boolean | null }>
}

export type HydratedMap = {
  groups: NetworkMapGroup[]
  nodes: MergedCanvasNode[]
  edges: MergedCanvasEdge[]
}

export const STENCILS = [
  'switch',
  'router',
  'firewall',
  'ap',
  'server',
  'corax',
  'nas',
  'pc',
  'vm',
  'printer',
  'cloud',
] as const

export const MAX_MAP_IMAGES = 24

export function isDecorStencil(stencil: NetworkMapStencil): boolean {
  return stencil === 'note' || stencil === 'image'
}

export function emptyNetworkMapScene(): NetworkMapScene {
  return {
    version: NETWORK_MAP_SCENE_VERSION,
    groups: [],
    nodes: [],
    edges: [],
    hiddenNodeIds: [],
    viewport: null,
  }
}

export function bindKey(bind: NetworkMapBind): string {
  if (bind.type === 'corax') return 'corax:self'
  return `${bind.type}:${bind.id}`
}

export function parseTopologyId(id: string): NetworkMapBind | null {
  if (id === 'corax:self' || id === 'corax:0') return { type: 'corax', id: 0 }
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  const type = id.slice(0, idx)
  const raw = id.slice(idx + 1)
  if (type !== 'network_device' && type !== 'computer' && type !== 'printer' && type !== 'corax' && type !== 'zabbix') return null
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  return { type, id: num }
}
