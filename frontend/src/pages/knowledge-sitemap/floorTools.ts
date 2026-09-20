import type { Computer, FloorIconKind, FloorIconMarker, FloorLayout, NetworkPrinter, PcHoverCardField } from '../../api'
import type { MessageKey } from '../../i18n/LocaleContext'

export type ViewBox = { x: number; y: number; w: number; h: number }

export const DEFAULT_VIEWBOX: ViewBox = { x: 0, y: 0, w: 1200, h: 800 }
export const DEFAULT_PC_HOVER_FIELDS: PcHoverCardField[] = ['title', 'outlets', 'ip', 'os', 'ping_status']
export const PC_HOVER_FIELD_OPTIONS: Array<{ id: PcHoverCardField; label: string }> = [
  { id: 'title', label: 'Название объекта' },
  { id: 'hostname', label: 'Имя ПК' },
  { id: 'employee_extension', label: 'Внутренний номер' },
  { id: 'outlets', label: 'Розетки' },
  { id: 'ip', label: 'IP-адрес' },
  { id: 'mac', label: 'MAC-адрес' },
  { id: 'os', label: 'ОС' },
  { id: 'cpu', label: 'Процессор' },
  { id: 'ram', label: 'Оперативная память' },
  { id: 'manufacturer', label: 'Производитель' },
  { id: 'model', label: 'Модель' },
  { id: 'serial_number', label: 'Серийный номер' },
  { id: 'tags', label: 'Теги' },
  { id: 'ping_status', label: 'Статус сети' },
]
export const PC_HOVER_FIELD_IDS = new Set<PcHoverCardField>(PC_HOVER_FIELD_OPTIONS.map((field) => field.id))
export const DEFAULT_LAYOUT: FloorLayout = {
  version: 1,
  rooms: [],
  computers: [],
  icons: [],
  walls: [],
  settings: { pc_hover_card: { fields: DEFAULT_PC_HOVER_FIELDS } },
}
export const LS_KEY_LAST_FLOOR_ID = 'inventory.knowledge_building_map.last_floor_id'

/**
 * Inventory data is live; marker meta is a legacy snapshot kept only as a
 * fallback for layouts whose linked PC has since been removed.
 */
export function linkedPcDisplay(marker: FloorIconMarker, pc: Computer | null) {
  const meta = marker.meta ?? {}
  const first = (...values: Array<string | null | undefined>) =>
    values.find((value) => Boolean(value?.trim()))?.trim() || '—'

  return {
    hostname: first(pc?.hostname, meta.computer_id),
    serialNumber: first(pc?.serial_number),
    ip: first(pc?.ip_address, meta.ip),
    os: first(pc?.os_name, meta.os_name),
    cpu: first(pc?.cpu, meta.cpu),
    ramGb: pc?.ram_gb ?? (meta.ram_gb ? Number(meta.ram_gb) : null),
    manufacturer: first(pc?.manufacturer, meta.manufacturer),
    model: first(pc?.model, meta.model),
    mac: first(pc?.mac_primary, meta.mac),
    tags: pc?.tags ?? [],
  }
}

export function normalizedPcHoverFields(layout: FloorLayout): PcHoverCardField[] {
  const raw = layout.settings?.pc_hover_card?.fields
  if (!raw) return DEFAULT_PC_HOVER_FIELDS
  const fields = raw.filter((field): field is PcHoverCardField => PC_HOVER_FIELD_IDS.has(field))
  return [...new Set(fields)]
}

export function pcHoverFieldOptionsInOrder(fields: PcHoverCardField[]) {
  const selected = new Set(fields)
  const byId = new Map(PC_HOVER_FIELD_OPTIONS.map((field) => [field.id, field]))
  return [...fields, ...PC_HOVER_FIELD_OPTIONS.map((field) => field.id).filter((id) => !selected.has(id))]
    .map((id) => byId.get(id))
    .filter((field): field is { id: PcHoverCardField; label: string } => Boolean(field))
}

export const EQUIPMENT_KINDS: FloorIconKind[] = [
  'pc',
  'ethernet_outlet',
  'phone_outlet',
  'server',
  'ap',
  'switch',
  'printer',
  'text',
]

export const KIND_LABEL_KEY: Record<FloorIconKind, MessageKey> = {
  pc: 'sitemap.kinds.pc',
  server: 'sitemap.kinds.server',
  printer: 'sitemap.kinds.printer',
  camera: 'sitemap.kinds.camera',
  ap: 'sitemap.kinds.ap',
  switch: 'sitemap.kinds.switch',
  door: 'sitemap.kinds.door',
  stairs: 'sitemap.kinds.stairs',
  elevator: 'sitemap.kinds.elevator',
  text: 'sitemap.kinds.text',
  ethernet_outlet: 'sitemap.kinds.ethernet_outlet',
  phone_outlet: 'sitemap.kinds.phone_outlet',
}

export const LS_VIS_OUTLETS = 'inventory.building_map.outlet_visibility'

export type OutletVisibility = {
  ethOutlets: boolean
  phoneOutlets: boolean
  ethCables: boolean
  phoneCables: boolean
}

export const DEFAULT_OUTLET_VIS: OutletVisibility = {
  ethOutlets: true,
  phoneOutlets: true,
  ethCables: true,
  phoneCables: true,
}

export function loadOutletVisibility(diagramId: number | null): OutletVisibility {
  if (diagramId == null) return DEFAULT_OUTLET_VIS
  try {
    const raw = window.localStorage.getItem(`${LS_VIS_OUTLETS}.${diagramId}`)
    if (!raw) return DEFAULT_OUTLET_VIS
    const parsed = JSON.parse(raw) as Partial<OutletVisibility>
    return {
      ethOutlets: parsed.ethOutlets !== false,
      phoneOutlets: parsed.phoneOutlets !== false,
      ethCables: parsed.ethCables !== false,
      phoneCables: parsed.phoneCables !== false,
    }
  } catch {
    return DEFAULT_OUTLET_VIS
  }
}

export function saveOutletVisibility(diagramId: number | null, vis: OutletVisibility) {
  if (diagramId == null) return
  try {
    window.localStorage.setItem(`${LS_VIS_OUTLETS}.${diagramId}`, JSON.stringify(vis))
  } catch {
    /* */
  }
}

export function isOutletKind(kind: FloorIconKind): kind is 'ethernet_outlet' | 'phone_outlet' {
  return kind === 'ethernet_outlet' || kind === 'phone_outlet'
}

export function outletCableKind(kind: FloorIconKind): 'ethernet' | 'phone' {
  return kind === 'phone_outlet' ? 'phone' : 'ethernet'
}

export function outletNumber(marker: FloorIconMarker): string {
  return (marker.meta?.outlet_number ?? marker.label ?? '').trim()
}

export function pcOutletMetaField(kind: 'ethernet_outlet' | 'phone_outlet'): 'ethernet_outlet' | 'phone_outlet' {
  return kind === 'ethernet_outlet' ? 'ethernet_outlet' : 'phone_outlet'
}

export function syncOutletNumberToPc(icons: FloorIconMarker[], outletId: string): FloorIconMarker[] {
  const outlet = icons.find((m) => m.id === outletId)
  if (!outlet || !isOutletKind(outlet.kind)) return icons
  const pcId = (outlet.meta?.connected_pc_id ?? '').trim()
  if (!pcId) return icons
  const num = outletNumber(outlet)
  const field = pcOutletMetaField(outlet.kind)
  return icons.map((m) => (m.id === pcId ? { ...m, meta: { ...m.meta, [field]: num } } : m))
}

export function clearPcOutletField(
  icons: FloorIconMarker[],
  pcId: string,
  kind: 'ethernet_outlet' | 'phone_outlet',
): FloorIconMarker[] {
  const field = pcOutletMetaField(kind)
  return icons.map((m) => (m.id === pcId ? { ...m, meta: { ...m.meta, [field]: '' } } : m))
}

export function markerCircleFill(kind: FloorIconKind): string {
  if (kind === 'ethernet_outlet') return 'rgb(16,185,129)'
  if (kind === 'phone_outlet') return 'rgb(245,158,11)'
  if (kind === 'server') return 'rgb(15,23,42)'
  if (kind === 'ap') return 'rgb(225,29,72)'
  if (kind === 'printer') return 'rgb(202,138,4)'
  if (kind === 'switch') return 'rgb(8,145,178)'
  return 'rgb(37,99,235)'
}

export function markerMetaAfterKindChange(prev: FloorIconMarker, kind: FloorIconKind): FloorIconMarker['meta'] {
  const meta = { ...(prev.meta ?? {}) }
  if (kind !== 'pc') meta.computer_id = ''
  if (kind !== 'printer') meta.printer_id = ''
  if (!isOutletKind(kind)) meta.connected_pc_id = ''
  return meta
}

export function markerCircleRadius(kind: FloorIconKind): number {
  return isOutletKind(kind) ? 11 : 22
}

export function printerDisplayName(p: NetworkPrinter): string {
  return (p.name || '').trim() || (p.snmp_model || '').trim() || (p.ip_address || '').trim() || `#${p.id}`
}

export function printerLowestTonerPercent(p: { toner_min_percent?: number | null; supplies?: Array<{ level_percent: number | null }> }): number | null {
  if (p.toner_min_percent != null && Number.isFinite(p.toner_min_percent)) return p.toner_min_percent
  let min: number | null = null
  for (const s of p.supplies ?? []) {
    if (s.level_percent == null || !Number.isFinite(s.level_percent)) continue
    min = min == null ? s.level_percent : Math.min(min, s.level_percent)
  }
  return min
}

export function floorPcMarkerSearchText(pc: FloorIconMarker, pcDirectory: Computer[]): string {
  const parts = [markerTitle(pc), pc.label ?? '', pc.id, pc.meta?.ip ?? '', pc.meta?.mac ?? '']
  const parkId = (pc.meta?.computer_id ?? '').trim()
  if (parkId) {
    const host = pcDirectory.find((c) => String(c.id) === parkId)?.hostname
    if (host) parts.push(host)
  }
  return parts.join(' ').toLowerCase()
}

export function floorPcMarkerCaption(pc: FloorIconMarker, pcDirectory: Computer[]): { primary: string; secondary: string | null } {
  const primary = markerTitle(pc)
  const parkId = (pc.meta?.computer_id ?? '').trim()
  const host = parkId ? pcDirectory.find((c) => String(c.id) === parkId)?.hostname : null
  const ip = (pc.meta?.ip ?? '').trim()
  if (host) return { primary, secondary: host }
  if (ip) return { primary, secondary: ip }
  return { primary, secondary: null }
}

export function parseViewBox(raw: string | null | undefined): ViewBox {
  const parts = (raw ?? '').trim().split(/\s+/).map(Number)
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return DEFAULT_VIEWBOX
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
}

/** Не даём отдалиться шире фона этажа (без полей с серым вокруг картинки), с сохранением соотношения сторон камеры. */
export function clampCameraZoomToFloorExtent(cam: ViewBox, fe: ViewBox): ViewBox {
  if (!(fe.w > 0) || !(fe.h > 0)) return cam
  if (!(cam.w > 0) || !(cam.h > 0)) return cam
  const ar = cam.w / cam.h
  const nwMax = Math.max(fe.w, fe.h * ar)
  const minWBase = Math.max(40, fe.w * 0.03)
  const minW = Math.min(minWBase, nwMax)
  let nw = Math.min(cam.w, nwMax)
  nw = Math.max(minW, nw)
  const nh = (nw * cam.h) / cam.w
  let nx = cam.x
  let ny = cam.y
  nx = Math.min(fe.x + fe.w - nw, Math.max(fe.x, nx))
  ny = Math.min(fe.y + fe.h - nh, Math.max(fe.y, ny))
  return { x: nx, y: ny, w: nw, h: nh }
}

export function normalizeLayout(layout: FloorLayout | null | undefined): FloorLayout {
  return {
    version: 1,
    rooms: Array.isArray(layout?.rooms) ? layout.rooms : [],
    computers: Array.isArray(layout?.computers) ? layout.computers : [],
    icons: Array.isArray(layout?.icons) ? layout.icons : [],
    walls: Array.isArray(layout?.walls) ? layout.walls : [],
    settings: layout?.settings?.pc_hover_card
      ? { pc_hover_card: { fields: normalizedPcHoverFields(layout) } }
      : undefined,
  }
}

export function stripUndefinedDeep(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map(stripUndefinedDeep).filter((v) => v !== undefined)
  }
  const o = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) continue
    const nv = stripUndefinedDeep(v)
    if (nv !== undefined) out[k] = nv
  }
  return out
}

export function sortJsonKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortJsonKeys)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(obj).sort()) {
    out[k] = sortJsonKeys(obj[k])
  }
  return out
}

/** Стабильное сравнение для live-refetch: координаты округлены, ключи JSON упорядочены. */
export function roundIconsForLiveFingerprint(layout: FloorLayout): FloorLayout {
  const n = normalizeLayout(layout)
  const icons = [...(n.icons ?? [])]
    .map((m) => ({
      ...m,
      x: Math.round(m.x * 1e4) / 1e4,
      y: Math.round(m.y * 1e4) / 1e4,
      scale: m.scale != null && Number.isFinite(m.scale) ? Math.round(m.scale * 1e4) / 1e4 : m.scale,
      rotation:
        m.rotation != null && Number.isFinite(m.rotation) ? Math.round(m.rotation * 1e4) / 1e4 : m.rotation,
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { ...n, icons }
}

export function floorLayoutLiveFingerprint(layout: FloorLayout): string {
  return JSON.stringify(sortJsonKeys(stripUndefinedDeep(roundIconsForLiveFingerprint(layout))))
}

export function viewBoxesCloseEnough(a: ViewBox, b: ViewBox, eps = 1e-3): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.w - b.w) <= eps &&
    Math.abs(a.h - b.h) <= eps
  )
}

export function markerTitle(marker: FloorIconMarker | null, kindFallback = ''): string {
  if (!marker) return kindFallback
  if (isOutletKind(marker.kind)) {
    const num = outletNumber(marker)
    if (num) return `№ ${num}`
  }
  return (marker.label ?? marker.meta?.title ?? '').trim() || kindFallback || marker.kind
}

export function splitLabelLines(input: string): string[] {
  const words = (input || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  if (words.length === 1) return [words[0]]
  const cut = Math.ceil(words.length / 2)
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')]
}

export function clientToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const m = svg.getScreenCTM()
  if (!m) return null
  const p = svg.createSVGPoint()
  p.x = clientX
  p.y = clientY
  const mapped = p.matrixTransform(m.inverse())
  return { x: mapped.x, y: mapped.y }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение фона'))
    reader.readAsDataURL(blob)
  })
}
