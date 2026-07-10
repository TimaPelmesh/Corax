import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent,
} from 'react'
import { api, type Computer, type ComputerDetail, type Diagram, type FloorIconKind, type FloorIconMarker, type FloorLayout } from '../api'
import { useAuth } from '../AuthContext'
import { useDiagramLive, type DiagramLiveIconDrag } from '../useDiagramLive'
import {
  MAX_PLACE_PHOTOS,
  compressImageFileToJpegDataUrl,
  firstPlacePhotoDataUrl,
  parsePlacePhotosJson,
  serializePlacePhotos,
} from '../floorPlacePhotos'
import { IconClose, IconGraph } from '../components/icons'

type ViewBox = { x: number; y: number; w: number; h: number }

const DEFAULT_VIEWBOX: ViewBox = { x: 0, y: 0, w: 1200, h: 800 }
const DEFAULT_LAYOUT: FloorLayout = { version: 1, rooms: [], computers: [], icons: [], walls: [] }
const LS_KEY_LAST_FLOOR_ID = 'inventory.knowledge_building_map.last_floor_id'

const EQUIPMENT: Array<{ kind: FloorIconKind; label: string }> = [
  { kind: 'pc', label: 'ПК' },
  { kind: 'ethernet_outlet', label: 'Розетка Ethernet' },
  { kind: 'phone_outlet', label: 'Тел. розетка' },
  { kind: 'server', label: 'Сервер' },
  { kind: 'ap', label: 'Точка доступа' },
  { kind: 'switch', label: 'Коммутатор' },
  { kind: 'printer', label: 'Принтер' },
  { kind: 'text', label: 'Надпись' },
]

const KIND_LABEL: Record<FloorIconKind, string> = {
  pc: 'ПК',
  server: 'Сервер',
  printer: 'Принтер',
  camera: 'Камера',
  ap: 'Точка доступа',
  switch: 'Коммутатор',
  door: 'Дверь',
  stairs: 'Лестница',
  elevator: 'Лифт',
  text: 'Надпись',
  ethernet_outlet: 'Розетка Ethernet',
  phone_outlet: 'Тел. розетка',
}

const LS_VIS_OUTLETS = 'inventory.building_map.outlet_visibility'

type OutletVisibility = {
  ethOutlets: boolean
  phoneOutlets: boolean
  ethCables: boolean
  phoneCables: boolean
}

const DEFAULT_OUTLET_VIS: OutletVisibility = {
  ethOutlets: true,
  phoneOutlets: true,
  ethCables: true,
  phoneCables: true,
}

function loadOutletVisibility(diagramId: number | null): OutletVisibility {
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

function saveOutletVisibility(diagramId: number | null, vis: OutletVisibility) {
  if (diagramId == null) return
  try {
    window.localStorage.setItem(`${LS_VIS_OUTLETS}.${diagramId}`, JSON.stringify(vis))
  } catch {
    /* */
  }
}

function isOutletKind(kind: FloorIconKind): kind is 'ethernet_outlet' | 'phone_outlet' {
  return kind === 'ethernet_outlet' || kind === 'phone_outlet'
}

function outletCableKind(kind: FloorIconKind): 'ethernet' | 'phone' {
  return kind === 'phone_outlet' ? 'phone' : 'ethernet'
}

function outletNumber(marker: FloorIconMarker): string {
  return (marker.meta?.outlet_number ?? marker.label ?? '').trim()
}

function pcOutletMetaField(kind: 'ethernet_outlet' | 'phone_outlet'): 'ethernet_outlet' | 'phone_outlet' {
  return kind === 'ethernet_outlet' ? 'ethernet_outlet' : 'phone_outlet'
}

function syncOutletNumberToPc(icons: FloorIconMarker[], outletId: string): FloorIconMarker[] {
  const outlet = icons.find((m) => m.id === outletId)
  if (!outlet || !isOutletKind(outlet.kind)) return icons
  const pcId = (outlet.meta?.connected_pc_id ?? '').trim()
  if (!pcId) return icons
  const num = outletNumber(outlet)
  const field = pcOutletMetaField(outlet.kind)
  return icons.map((m) => (m.id === pcId ? { ...m, meta: { ...m.meta, [field]: num } } : m))
}

function clearPcOutletField(
  icons: FloorIconMarker[],
  pcId: string,
  kind: 'ethernet_outlet' | 'phone_outlet',
): FloorIconMarker[] {
  const field = pcOutletMetaField(kind)
  return icons.map((m) => (m.id === pcId ? { ...m, meta: { ...m.meta, [field]: '' } } : m))
}

function markerCircleFill(kind: FloorIconKind): string {
  if (kind === 'ethernet_outlet') return 'rgb(16,185,129)'
  if (kind === 'phone_outlet') return 'rgb(245,158,11)'
  if (kind === 'server') return 'rgb(15,23,42)'
  if (kind === 'ap') return 'rgb(225,29,72)'
  if (kind === 'printer') return 'rgb(202,138,4)'
  return 'rgb(37,99,235)'
}

function markerCircleRadius(kind: FloorIconKind): number {
  return isOutletKind(kind) ? 11 : 22
}

function floorPcMarkerSearchText(pc: FloorIconMarker, pcDirectory: Computer[]): string {
  const parts = [markerTitle(pc), pc.label ?? '', pc.id, pc.meta?.ip ?? '', pc.meta?.mac ?? '']
  const parkId = (pc.meta?.computer_id ?? '').trim()
  if (parkId) {
    const host = pcDirectory.find((c) => String(c.id) === parkId)?.hostname
    if (host) parts.push(host)
  }
  return parts.join(' ').toLowerCase()
}

function floorPcMarkerCaption(pc: FloorIconMarker, pcDirectory: Computer[]): { primary: string; secondary: string | null } {
  const primary = markerTitle(pc)
  const parkId = (pc.meta?.computer_id ?? '').trim()
  const host = parkId ? pcDirectory.find((c) => String(c.id) === parkId)?.hostname : null
  const ip = (pc.meta?.ip ?? '').trim()
  if (host) return { primary, secondary: host }
  if (ip) return { primary, secondary: ip }
  return { primary, secondary: null }
}

function FloorPcMarkerPicker({
  pcMarkers,
  valueId,
  onChange,
  pcDirectory,
  disabled,
}: {
  pcMarkers: FloorIconMarker[]
  valueId: string
  onChange: (id: string) => void
  pcDirectory: Computer[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => (valueId ? pcMarkers.find((m) => m.id === valueId) : undefined),
    [pcMarkers, valueId],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return pcMarkers.slice(0, 40)
    return pcMarkers.filter((m) => floorPcMarkerSearchText(m, pcDirectory).includes(q)).slice(0, 40)
  }, [pcMarkers, pcDirectory, query])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const displayValue = open
    ? query
    : selected
      ? floorPcMarkerCaption(selected, pcDirectory).primary
      : ''

  return (
    <div ref={boxRef} className="relative mt-0.5">
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder="Поиск: название, IP, hostname…"
          value={displayValue}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value)
            onChange('')
            setOpen(true)
          }}
          onFocus={() => {
            setQuery(selected ? floorPcMarkerCaption(selected, pcDirectory).primary : '')
            setOpen(true)
          }}
          className="h-9 w-full rounded-lg border border-neutral-200 bg-white py-2 pl-2.5 pr-14 text-sm text-neutral-900 outline-none transition placeholder:text-slate-400 focus:border-neutral-400 disabled:opacity-60"
        />
        {selected && !disabled ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            onClick={() => {
              onChange('')
              setQuery('')
              setOpen(false)
            }}
          >
            Сброс
          </button>
        ) : null}
      </div>
      {open && !disabled ? (
        <ul
          className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-[0_12px_32px_-12px_rgba(2,6,23,0.35)]"
          role="listbox"
        >
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-slate-500 hover:bg-neutral-50"
              onClick={() => {
                onChange('')
                setQuery('')
                setOpen(false)
              }}
            >
              — не подключено —
            </button>
          </li>
          {filtered.map((pc) => {
            const cap = floorPcMarkerCaption(pc, pcDirectory)
            return (
              <li key={pc.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-neutral-50"
                  onClick={() => {
                    onChange(pc.id)
                    setQuery(cap.primary)
                    setOpen(false)
                  }}
                >
                  <div className="text-sm font-medium text-neutral-900">{cap.primary}</div>
                  {cap.secondary ? <div className="text-xs text-slate-500">{cap.secondary}</div> : null}
                </button>
              </li>
            )
          })}
          {pcMarkers.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-400">На этаже нет объектов «ПК»</li>
          ) : filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-slate-400">Ничего не найдено</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

const PERIPHERAL_KIND_RU: Record<string, string> = {
  keyboard: 'Клавиатура',
  mouse: 'Мышь',
  monitor: 'Монитор',
  camera: 'Камера',
  audio: 'Аудио',
  printer: 'Принтер',
  biometric: 'Биометрия',
  bluetooth: 'Bluetooth',
  touchpad: 'Тачпад',
  net: 'Сеть',
}

function parseViewBox(raw: string | null | undefined): ViewBox {
  const parts = (raw ?? '').trim().split(/\s+/).map(Number)
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return DEFAULT_VIEWBOX
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
}

/** Не даём отдалиться шире фона этажа (без полей с серым вокруг картинки), с сохранением соотношения сторон камеры. */
function clampCameraZoomToFloorExtent(cam: ViewBox, fe: ViewBox): ViewBox {
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

function normalizeLayout(layout: FloorLayout | null | undefined): FloorLayout {
  return {
    version: 1,
    rooms: Array.isArray(layout?.rooms) ? layout.rooms : [],
    computers: Array.isArray(layout?.computers) ? layout.computers : [],
    icons: Array.isArray(layout?.icons) ? layout.icons : [],
    walls: Array.isArray(layout?.walls) ? layout.walls : [],
  }
}

function stripUndefinedDeep(value: unknown): unknown {
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

function sortJsonKeys(value: unknown): unknown {
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
function roundIconsForLiveFingerprint(layout: FloorLayout): FloorLayout {
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

function floorLayoutLiveFingerprint(layout: FloorLayout): string {
  return JSON.stringify(sortJsonKeys(stripUndefinedDeep(roundIconsForLiveFingerprint(layout))))
}

function viewBoxesCloseEnough(a: ViewBox, b: ViewBox, eps = 1e-3): boolean {
  return (
    Math.abs(a.x - b.x) <= eps &&
    Math.abs(a.y - b.y) <= eps &&
    Math.abs(a.w - b.w) <= eps &&
    Math.abs(a.h - b.h) <= eps
  )
}

function markerTitle(marker: FloorIconMarker | null): string {
  if (!marker) return 'Объект не выбран'
  if (isOutletKind(marker.kind)) {
    const num = outletNumber(marker)
    if (num) return `№ ${num}`
  }
  return (marker.label ?? marker.meta?.title ?? '').trim() || KIND_LABEL[marker.kind]
}

function splitLabelLines(input: string): string[] {
  const words = (input || '').trim().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  if (words.length === 1) return [words[0]]
  const cut = Math.ceil(words.length / 2)
  return [words.slice(0, cut).join(' '), words.slice(cut).join(' ')]
}

function clientToSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } | null {
  const m = svg.getScreenCTM()
  if (!m) return null
  const p = svg.createSVGPoint()
  p.x = clientX
  p.y = clientY
  const mapped = p.matrixTransform(m.inverse())
  return { x: mapped.x, y: mapped.y }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('Не удалось прочитать изображение фона'))
    reader.readAsDataURL(blob)
  })
}

function fmtDate(iso: string | null) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ru-RU')
  } catch {
    return iso
  }
}

function EquipmentGlyph({ kind }: { kind: FloorIconKind }) {
  if (kind === 'text') return null
  if (kind === 'pc') {
    return (
      <>
        <rect x="-13" y="-10" width="26" height="16" rx="2.5" fill="white" />
        <rect x="-6" y="8" width="12" height="3" rx="1.5" fill="rgba(255,255,255,0.86)" />
        <rect x="-10" y="11.5" width="20" height="3" rx="1.5" fill="rgba(255,255,255,0.72)" />
      </>
    )
  }
  if (kind === 'server') {
    return (
      <>
        <rect x="-12" y="-16" width="24" height="32" rx="3" fill="white" />
        <rect x="-7" y="-10" width="14" height="3" rx="1.5" fill="rgba(15,23,42,0.45)" />
        <rect x="-7" y="-2" width="14" height="3" rx="1.5" fill="rgba(15,23,42,0.45)" />
        <circle cx="7" cy="9" r="2" fill="rgb(34,197,94)" />
      </>
    )
  }
  if (kind === 'ap') {
    return (
      <>
        <g transform="translate(0 -0.8)">
          <path
            d="M -10.2 -2.7 Q 0 -10.2 10.2 -2.7"
            fill="none"
            stroke="white"
            strokeWidth="2.05"
            strokeLinecap="round"
          />
          <path
            d="M -6.6 -0.4 Q 0 -5.1 6.6 -0.4"
            fill="none"
            stroke="white"
            strokeWidth="1.95"
            strokeLinecap="round"
            opacity="0.97"
          />
          <path
            d="M -3.2 1.8 Q 0 -0.5 3.2 1.8"
            fill="none"
            stroke="white"
            strokeWidth="1.85"
            strokeLinecap="round"
            opacity="0.98"
          />
          <circle cx="0" cy="4.8" r="1.7" fill="white" />
        </g>
      </>
    )
  }
  if (kind === 'printer') {
    return (
      <>
        <rect x="-13.5" y="-15.5" width="27" height="10" rx="2.6" fill="rgba(255,255,255,0.74)" />
        <rect x="-16.5" y="-7" width="33" height="22" rx="4.8" fill="white" />
        <rect x="-11" y="2.8" width="22" height="8.4" rx="1.8" fill="rgba(15,23,42,0.12)" />
        <circle cx="10.2" cy="-1.2" r="1.5" fill="rgba(15,23,42,0.35)" />
      </>
    )
  }
  if (kind === 'ethernet_outlet') {
    return (
      <>
        <rect x="-6.5" y="-4.9" width="13" height="10" rx="1.8" fill="white" />
        <rect x="-3.9" y="-1.8" width="7.8" height="3.5" rx="0.7" fill="rgba(15,23,42,0.35)" />
        <rect x="-2.1" y="-3.5" width="4.2" height="1.5" rx="0.4" fill="rgba(15,23,42,0.22)" />
      </>
    )
  }
  if (kind === 'phone_outlet') {
    return (
      <>
        <rect x="-5.6" y="-6.3" width="11.2" height="12.6" rx="2.1" fill="white" />
        <circle cx="0" cy="0" r="2.2" fill="rgba(15,23,42,0.35)" />
        <rect x="-0.85" y="-3.9" width="1.7" height="2.5" rx="0.4" fill="rgba(255,255,255,0.92)" />
      </>
    )
  }
  return (
    <>
      <rect x="-18" y="-11" width="36" height="22" rx="5" fill="white" />
      <rect x="-11" y="-3" width="22" height="6" rx="3" fill="rgba(15,23,42,0.35)" />
    </>
  )
}

function EquipmentMenuIcon({ kind }: { kind: FloorIconKind }) {
  return (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 text-neutral-700">
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'pc' ? (
          <>
            <rect x="3.5" y="4.5" width="17" height="11" rx="1.8" />
            <path d="M8 19h8" />
            <path d="M10 15.5v3.5M14 15.5v3.5" />
          </>
        ) : kind === 'server' ? (
          <>
            <rect x="5" y="3.5" width="14" height="17" rx="2" />
            <path d="M8 8h8M8 12h8" />
            <circle cx="16.5" cy="16.5" r="1.1" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'ap' ? (
          <>
            <path d="M3.5 10.5Q12 2.5 20.5 10.5" />
            <path d="M6.5 13.5Q12 8 17.5 13.5" />
            <path d="M9.5 16.2Q12 13.8 14.5 16.2" />
            <circle cx="12" cy="19" r="1.3" fill="currentColor" stroke="none" />
          </>
        ) : kind === 'switch' ? (
          <>
            <rect x="3.5" y="7" width="17" height="10" rx="2" />
            <path d="M7 11h1M10 11h1M13 11h1M16 11h1" />
          </>
        ) : kind === 'printer' ? (
          <>
            <rect x="6.5" y="3.5" width="11" height="5" rx="1.5" />
            <rect x="4.5" y="9" width="15" height="9" rx="2" />
            <path d="M8 14.5h8" />
          </>
        ) : kind === 'ethernet_outlet' ? (
          <>
            <rect x="6" y="7" width="12" height="10" rx="2" />
            <rect x="8.5" y="10" width="7" height="4" rx="1" />
          </>
        ) : kind === 'phone_outlet' ? (
          <>
            <rect x="7" y="5" width="10" height="14" rx="2.5" />
            <circle cx="12" cy="12" r="2.2" />
          </>
        ) : (
          <>
            <path d="M6 8h12M6 12h12M6 16h8" />
          </>
        )}
      </svg>
    </span>
  )
}

export function KnowledgeSitemapPage() {
  const { user } = useAuth()
  const canEdit = !!user && (user.is_superuser || user.role === 'editor')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const floorMenuRef = useRef<HTMLDivElement | null>(null)
  const autosaveTimerRef = useRef<number | null>(null)
  const autosaveInFlightRef = useRef(false)
  const pendingIconsRef = useRef<FloorIconMarker[] | null>(null)
  const loadedRef = useRef(false)
  const [diagrams, setDiagrams] = useState<Diagram[]>([])
  const [pcDirectory, setPcDirectory] = useState<Computer[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [layout, setLayout] = useState<FloorLayout>(DEFAULT_LAYOUT)
  /** Эфемерные координаты с WS (чужой drag) — не трогаем layout, чтобы не дёргать автосохранение. */
  const [remoteIconPositions, setRemoteIconPositions] = useState<Record<string, { x: number; y: number }>>({})
  /** Границы этажа в координатах SVG (из экспорта), фон и логика объектов. */
  const [floorExtent, setFloorExtent] = useState<ViewBox>(DEFAULT_VIEWBOX)
  /** «Камера» — текущий видимый фрагмент (зум колесом). */
  const [cameraView, setCameraView] = useState<ViewBox>(DEFAULT_VIEWBOX)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [diagramRefreshKey, setDiagramRefreshKey] = useState(0)
  const dragRef = useRef<{
    originX: number
    originY: number
    markerIds: string[]
    start: Record<string, { x: number; y: number }>
  } | null>(null)
  /** Перетаскивание фона ЛКМ — сдвиг камеры (viewBox). */
  const panRef = useRef<{
    pointerId: number
    lastClientX: number
    lastClientY: number
    startClientX: number
    startClientY: number
    engaged: boolean
  } | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const lastIconDragSentMsRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [floorMenuOpen, setFloorMenuOpen] = useState(false)
  const [renamingFloor, setRenamingFloor] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [showHoverCard, setShowHoverCard] = useState(true)
  const [exportWithLabels, setExportWithLabels] = useState(true)
  const [outletVis, setOutletVis] = useState<OutletVisibility>(DEFAULT_OUTLET_VIS)
  const [pcLinkDialogOpen, setPcLinkDialogOpen] = useState(false)
  const [pcLinkQuery, setPcLinkQuery] = useState('')
  const [pcDetail, setPcDetail] = useState<ComputerDetail | null>(null)
  const [pcDetailLoading, setPcDetailLoading] = useState(false)
  const [pcInfoModalOpen, setPcInfoModalOpen] = useState(false)
  const [pcInfoSwFilter, setPcInfoSwFilter] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [photoLightboxUrl, setPhotoLightboxUrl] = useState<string | null>(null)
  const placePhotoInputRef = useRef<HTMLInputElement | null>(null)
  const placePhotosSectionRef = useRef<HTMLDivElement | null>(null)
  const [placePhotoBusy, setPlacePhotoBusy] = useState(false)
  const [photoFileDragOverLayout, setPhotoFileDragOverLayout] = useState(false)
  const hoverPhotoClipId = useId().replace(/:/g, 'c')
  const placePhotosHelpTipId = useId().replace(/:/g, 'h')

  const placePhotosHelpText = useMemo(
    () =>
      `До ${MAX_PLACE_PHOTOS} снимков. Изображения сжимаются и сохраняются в карте этажа — наведите на объект, чтобы увидеть превью в подсказке. Можно перетащить файлы с рабочего стола на карту (в эту область подсветится блок фото).`,
    [],
  )

  useEffect(() => {
    if (!photoLightboxUrl) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPhotoLightboxUrl(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [photoLightboxUrl])

  const activeDiagram = useMemo(() => diagrams.find((d) => d.id === activeId) ?? null, [activeId, diagrams])

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || loading || !activeDiagram) return
    const fe = floorExtent
    if (!(fe.w > 0) || !(fe.h > 0)) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setCameraView((cam) => {
        const pt = clientToSvgPoint(svg, e.clientX, e.clientY)
        if (!pt) return cam
        const zoomIn = e.deltaY < 0
        const factor = zoomIn ? 1 / 1.11 : 1.11
        let nw = cam.w * factor
        let nh = (nw * cam.h) / cam.w
        let nx = pt.x - ((pt.x - cam.x) / cam.w) * nw
        let ny = pt.y - ((pt.y - cam.y) / cam.h) * nh
        return clampCameraZoomToFloorExtent({ x: nx, y: ny, w: nw, h: nh }, fe)
      })
    }

    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [loading, activeDiagram, floorExtent])

  const markers = layout.icons ?? []
  const markersRef = useRef(markers)
  useEffect(() => {
    markersRef.current = markers
  }, [markers])

  useEffect(() => {
    setOutletVis(loadOutletVisibility(activeId))
  }, [activeId])

  const setOutletVisibility = useCallback(
    (patch: Partial<OutletVisibility>) => {
      setOutletVis((prev) => {
        const next = { ...prev, ...patch }
        saveOutletVisibility(activeId, next)
        return next
      })
    },
    [activeId],
  )

  const pcMarkersOnFloor = useMemo(() => markers.filter((m) => m.kind === 'pc'), [markers])

  const visibleMarkers = useMemo(() => {
    return markers.filter((m) => {
      if (m.kind === 'ethernet_outlet') return outletVis.ethOutlets
      if (m.kind === 'phone_outlet') return outletVis.phoneOutlets
      return true
    })
  }, [markers, outletVis.ethOutlets, outletVis.phoneOutlets])
  const markerDisplayPos = useCallback(
    (m: FloorIconMarker) => {
      if (dragRef.current?.markerIds.includes(m.id)) return { x: m.x, y: m.y }
      const rp = remoteIconPositions[m.id]
      return { x: rp?.x ?? m.x, y: rp?.y ?? m.y }
    },
    [remoteIconPositions],
  )

  const outletCableSegments = useMemo(() => {
    const byId = new Map(markers.map((m) => [m.id, m]))
    const segments: Array<{
      id: string
      kind: 'ethernet' | 'phone'
      x1: number
      y1: number
      x2: number
      y2: number
    }> = []
    for (const outlet of markers) {
      if (!isOutletKind(outlet.kind)) continue
      const pcId = (outlet.meta?.connected_pc_id ?? '').trim()
      if (!pcId) continue
      const pc = byId.get(pcId)
      if (!pc || pc.kind !== 'pc') continue
      const o = markerDisplayPos(outlet)
      const p = markerDisplayPos(pc)
      segments.push({
        id: `${outlet.id}-${pcId}`,
        kind: outletCableKind(outlet.kind),
        x1: o.x,
        y1: o.y,
        x2: p.x,
        y2: p.y,
      })
    }
    return segments
  }, [markers, markerDisplayPos])

  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null
  const selectedMarker = useMemo(
    () => markers.find((m) => m.id === selectedId) ?? null,
    [markers, selectedId],
  )
  const hoveredMarker = useMemo(() => markers.find((m) => m.id === hoveredId) ?? null, [hoveredId, markers])
  const hoveredDisplayPos = useMemo(() => {
    if (!hoveredMarker) return null
    return markerDisplayPos(hoveredMarker)
  }, [hoveredMarker, markerDisplayPos])
  const hoveredLinkedPc = useMemo(() => {
    const pcId = hoveredMarker?.meta?.computer_id
    if (!pcId) return null
    return pcDirectory.find((pc) => String(pc.id) === String(pcId)) ?? null
  }, [hoveredMarker, pcDirectory])
  const filteredPcDirectory = useMemo(() => {
    const q = pcLinkQuery.trim().toLowerCase()
    if (!q) return pcDirectory
    return pcDirectory.filter((pc) => {
      const host = (pc.hostname || '').toLowerCase()
      const serial = (pc.serial_number || '').toLowerCase()
      const model = (pc.model || '').toLowerCase()
      return host.includes(q) || serial.includes(q) || model.includes(q)
    })
  }, [pcDirectory, pcLinkQuery])
  const selectedLinkedPc = useMemo(() => {
    if (selectedMarker?.kind !== 'pc') return null
    const linkedId = selectedMarker.meta?.computer_id
    if (!linkedId) return null
    return pcDirectory.find((pc) => String(pc.id) === String(linkedId)) ?? null
  }, [pcDirectory, selectedMarker])
  const filteredPcSoftware = useMemo(() => {
    if (!pcDetail) return []
    const q = pcInfoSwFilter.trim().toLowerCase()
    if (!q) return pcDetail.software
    return pcDetail.software.filter((s) => s.name.toLowerCase().includes(q))
  }, [pcDetail, pcInfoSwFilter])

  const loadDiagram = useCallback(async (id: number, opts?: { preserveSelection?: boolean; preserveCamera?: boolean }) => {
    loadedRef.current = false
    const data = await api.diagramExportJson(id)
    setLayout(normalizeLayout(data.layout))
    setRemoteIconPositions({})
    const vb = parseViewBox(data.viewBox)
    setFloorExtent(vb)
    if (!opts?.preserveCamera) {
      setCameraView(clampCameraZoomToFloorExtent(vb, vb))
    } else {
      setCameraView((cam) => clampCameraZoomToFloorExtent(cam, vb))
    }
    if (!opts?.preserveSelection) {
      setSelectedIds([])
      setHoveredId(null)
    }
    setSaveState('idle')
    window.setTimeout(() => {
      loadedRef.current = true
    }, 0)
  }, [])

  const lastLocalCommitAtRef = useRef(0)
  const activeIdLiveRef = useRef<number | null>(null)
  const liveRefetchGenRef = useRef(0)
  const layoutLiveCompareRef = useRef(layout)
  const floorExtentLiveCompareRef = useRef(floorExtent)
  useEffect(() => {
    layoutLiveCompareRef.current = layout
  }, [layout])
  useEffect(() => {
    floorExtentLiveCompareRef.current = floorExtent
  }, [floorExtent])
  useEffect(() => {
    activeIdLiveRef.current = activeId
  }, [activeId])

  const refetchForLive = useCallback(async () => {
    const id = activeIdLiveRef.current
    if (id == null) return
    const gen = ++liveRefetchGenRef.current
    try {
      const data = await api.diagramExportJson(id)
      if (gen !== liveRefetchGenRef.current) return
      const nextLayout = normalizeLayout(data.layout)
      const vb = parseViewBox(data.viewBox)
      if (
        floorLayoutLiveFingerprint(layoutLiveCompareRef.current) === floorLayoutLiveFingerprint(nextLayout) &&
        viewBoxesCloseEnough(floorExtentLiveCompareRef.current, vb)
      ) {
        return
      }
      if (gen !== liveRefetchGenRef.current) return
      setLayout(nextLayout)
      setRemoteIconPositions({})
      setFloorExtent(vb)
      setCameraView((cam) => clampCameraZoomToFloorExtent(cam, vb))
      setSaveState('idle')
    } catch {
      /* фоновая подтяжка — не мешаем редактированию */
    }
  }, [])

  const onRemoteIconDragRef = useRef<((p: DiagramLiveIconDrag) => void) | null>(null)

  const {
    liveConnected,
    peers,
    sendIconDrag,
  } = useDiagramLive({
    diagramId: activeId,
    enabled: Boolean(user && activeId != null && !loading),
    saveState,
    autosaveInFlightRef,
    lastLocalCommitAtRef,
    refetchLayout: refetchForLive,
    onRemoteIconDragRef,
  })

  useEffect(() => {
    onRemoteIconDragRef.current = ({ user_id, icons }) => {
      if (user?.id != null && user_id === user.id) return
      setRemoteIconPositions((prev) => {
        const next = { ...prev }
        for (const u of icons) {
          if (dragRef.current?.markerIds.includes(u.id)) continue
          next[u.id] = { x: u.x, y: u.y }
        }
        return next
      })
    }
    return () => {
      onRemoteIconDragRef.current = null
    }
  }, [user?.id])

  const loadMaps = useCallback(async () => {
    setLoading(true)
    setErr(null)
    try {
      let rows = await api.diagrams()
      if (!rows.length) {
        const created = await api.createBlankFloor({ title: 'Карта сайта' })
        rows = [created]
      }
      setDiagrams(rows)
      let storedFloorId: number | null = null
      try {
        const raw = window.localStorage.getItem(LS_KEY_LAST_FLOOR_ID)
        const parsed = raw ? Number(raw) : NaN
        storedFloorId = Number.isFinite(parsed) ? parsed : null
      } catch {
        storedFloorId = null
      }
      const preferred =
        (storedFloorId != null ? rows.find((d) => d.id === storedFloorId) : null) ??
        rows.find((d) => d.title.toLowerCase().includes('карта')) ??
        rows[0]
      setActiveId(preferred.id)
      await loadDiagram(preferred.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось загрузить карту сайта')
    } finally {
      setLoading(false)
    }
  }, [loadDiagram])

  useEffect(() => {
    if (!activeId) return
    try {
      window.localStorage.setItem(LS_KEY_LAST_FLOOR_ID, String(activeId))
    } catch {
      // ignore storage failures
    }
  }, [activeId])

  useEffect(() => {
    void loadMaps()
  }, [loadMaps])

  useEffect(() => {
    void (async () => {
      try {
        const rows = await api.computers({ limit: 1000 })
        setPcDirectory(rows.items)
      } catch {
        setPcDirectory([])
      }
    })()
  }, [])

  useEffect(() => {
    return () => {
      if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!floorMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      const root = floorMenuRef.current
      if (!root) return
      if (!root.contains(e.target as Node)) setFloorMenuOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFloorMenuOpen(false)
    }
    window.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onEsc)
    }
  }, [floorMenuOpen])

  useEffect(() => {
    setPcDetail(null)
    setPcDetailLoading(false)
    setPcInfoModalOpen(false)
    setPcInfoSwFilter('')
  }, [selectedMarker?.id, selectedMarker?.meta?.computer_id])

  useEffect(() => {
    setPcLinkQuery('')
    setPcLinkDialogOpen(false)
  }, [selectedMarker?.id])

  const svgPoint = (event: PointerEvent<SVGSVGElement | SVGGElement>) => {
    const svg = svgRef.current
    const matrix = svg?.getScreenCTM()
    if (!svg || !matrix) return null
    const point = svg.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const mapped = point.matrixTransform(matrix.inverse())
    return {
      x: Math.max(floorExtent.x, Math.min(floorExtent.x + floorExtent.w, mapped.x)),
      y: Math.max(floorExtent.y, Math.min(floorExtent.y + floorExtent.h, mapped.y)),
    }
  }

  const updateMarker = (id: string, patch: Partial<FloorIconMarker>) => {
    if (!canEdit) return
    setLayout((current) => ({
      ...current,
      icons: (current.icons ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)),
    }))
  }

  const updateOutletMarker = (
    id: string,
    patch: Partial<FloorIconMarker>,
    opts?: { prevConnectedPcId?: string },
  ) => {
    if (!canEdit) return
    setLayout((current) => {
      let icons = (current.icons ?? []).map((m) => {
        if (m.id !== id) return m
        return {
          ...m,
          ...patch,
          meta: patch.meta ? { ...m.meta, ...patch.meta } : m.meta,
        }
      })
      const outlet = icons.find((m) => m.id === id)
      if (outlet && isOutletKind(outlet.kind)) {
        const prevPc = (opts?.prevConnectedPcId ?? '').trim()
        const nextPc = (outlet.meta?.connected_pc_id ?? '').trim()
        if (prevPc && prevPc !== nextPc) {
          icons = clearPcOutletField(icons, prevPc, outlet.kind)
        }
        icons = syncOutletNumberToPc(icons, id)
      }
      return { ...current, icons }
    })
  }

  const selectedPlacePhotos = useMemo(
    () => (selectedMarker ? parsePlacePhotosJson(selectedMarker.meta?.place_photos_json) : []),
    [selectedMarker?.meta?.place_photos_json, selectedMarker?.id],
  )

  const dataTransferHasFiles = (dt: DataTransfer | null) => {
    if (!dt?.types) return false
    return Array.from(dt.types).includes('Files')
  }

  const addPlacePhotoFilesFromFiles = useCallback(
    async (files: File[], opts?: { scrollSection?: boolean }) => {
      if (!canEdit) return
      const id = selectedIds.length === 1 ? selectedIds[0] : null
      if (!id) {
        setErr(
          'Сначала выберите один объект на карте, затем перетащите фото снова — снимки добавляются к выбранному оборудованию.',
        )
        return
      }
      const sm = markersRef.current.find((m) => m.id === id)
      if (!sm) return

      const imageFiles = files.filter((f) => f.type.startsWith('image/'))
      if (!imageFiles.length) return

      const existing = parsePlacePhotosJson(sm.meta?.place_photos_json)
      const slots = MAX_PLACE_PHOTOS - existing.length
      if (slots <= 0) {
        setErr('Достигнут лимит фото для этого объекта.')
        return
      }

      if (opts?.scrollSection) {
        window.requestAnimationFrame(() => {
          placePhotosSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
      }

      setPlacePhotoBusy(true)
      setErr(null)
      const toAdd: Array<{ id: string; dataUrl: string; caption: string }> = []
      try {
        for (const f of imageFiles) {
          if (toAdd.length >= slots) break
          const dataUrl = await compressImageFileToJpegDataUrl(f)
          toAdd.push({
            id: `ph-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            dataUrl,
            caption: '',
          })
        }
        setLayout((current) => {
          const m = (current.icons ?? []).find((icon) => icon.id === id)
          if (!m) return current
          let next = [...parsePlacePhotosJson(m.meta?.place_photos_json)]
          for (const row of toAdd) {
            if (next.length >= MAX_PLACE_PHOTOS) break
            next.push(row)
          }
          return {
            ...current,
            icons: (current.icons ?? []).map((icon) =>
              icon.id === id
                ? { ...icon, meta: { ...icon.meta, place_photos_json: serializePlacePhotos(next) } }
                : icon,
            ),
          }
        })
      } catch (ex) {
        setErr(ex instanceof Error ? ex.message : 'Не удалось добавить фото')
      } finally {
        setPlacePhotoBusy(false)
      }
    },
    [canEdit, selectedIds],
  )

  const onPickPlacePhotos = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    await addPlacePhotoFilesFromFiles(files)
  }

  const onLayoutDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!canEdit || !dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    setPhotoFileDragOverLayout(true)
  }

  const onLayoutDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!canEdit || !dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onLayoutDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const related = e.relatedTarget as Node | null
    if (!related || !e.currentTarget.contains(related)) {
      setPhotoFileDragOverLayout(false)
    }
  }

  const onLayoutDrop = (e: DragEvent<HTMLDivElement>) => {
    setPhotoFileDragOverLayout(false)
    if (!canEdit || !dataTransferHasFiles(e.dataTransfer)) return
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files ?? [])
    void addPlacePhotoFilesFromFiles(files, { scrollSection: true })
  }

  const removePlacePhoto = (photoId: string) => {
    if (!canEdit || !selectedMarker) return
    const next = parsePlacePhotosJson(selectedMarker.meta?.place_photos_json).filter((p) => p.id !== photoId)
    updateMarker(selectedMarker.id, {
      meta: {
        ...selectedMarker.meta,
        place_photos_json: next.length ? serializePlacePhotos(next) : '',
      },
    })
  }

  const setPlacePhotoCaption = (photoId: string, caption: string) => {
    if (!canEdit || !selectedMarker) return
    const next = parsePlacePhotosJson(selectedMarker.meta?.place_photos_json).map((p) =>
      p.id === photoId ? { ...p, caption } : p,
    )
    updateMarker(selectedMarker.id, {
      meta: { ...selectedMarker.meta, place_photos_json: serializePlacePhotos(next) },
    })
  }

  const addMarker = (kind: FloorIconKind) => {
    if (!canEdit) return
    const id = `${kind}-${Date.now().toString(36)}`
    const marker: FloorIconMarker = {
      id,
      kind,
      x: cameraView.x + cameraView.w / 2,
      y: cameraView.y + cameraView.h / 2,
      label: KIND_LABEL[kind],
      scale: kind === 'text' ? 1 : isOutletKind(kind) ? 0.67 : 1.1,
      meta: isOutletKind(kind)
        ? { title: KIND_LABEL[kind], outlet_number: '', connected_pc_id: '' }
        : { title: KIND_LABEL[kind], ip: '', mac: '', notes: '' },
    }
    setLayout((current) => ({ ...current, icons: [...(current.icons ?? []), marker] }))
    setSelectedIds([id])
  }

  const deleteSelected = () => {
    if (!canEdit) return
    if (!selectedIds.length) return
    const toDelete = new Set(selectedIds)
    setLayout((current) => {
      let icons = (current.icons ?? []).filter((m) => !toDelete.has(m.id))
      icons = icons.map((m) => {
        if (!isOutletKind(m.kind)) return m
        const linked = (m.meta?.connected_pc_id ?? '').trim()
        if (linked && toDelete.has(linked)) {
          return { ...m, meta: { ...m.meta, connected_pc_id: '' } }
        }
        return m
      })
      return { ...current, icons }
    })
    setSelectedIds([])
  }

  const saveLayout = useCallback(
    async (id: number, nextLayout: FloorLayout) => {
      setSaving(true)
      setSaveState('saving')
      setErr(null)
      try {
        await api.saveDiagramLayout(id, normalizeLayout(nextLayout))
        setLastSavedAt(Date.now())
        lastLocalCommitAtRef.current = Date.now()
        setSaveState('saved')
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Не удалось сохранить карту')
        setSaveState('error')
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  const flushIconsPatch = useCallback(async () => {
    if (!activeId || autosaveInFlightRef.current) return
    const icons = pendingIconsRef.current
    if (!icons) return
    pendingIconsRef.current = null
    autosaveInFlightRef.current = true
    setSaveState('saving')
    setErr(null)
    try {
      await api.patchDiagramLayout(activeId, { icons })
      setLastSavedAt(Date.now())
      lastLocalCommitAtRef.current = Date.now()
      setSaveState('saved')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось автосохранить изменения')
      setSaveState('error')
    } finally {
      autosaveInFlightRef.current = false
      if (pendingIconsRef.current) void flushIconsPatch()
    }
  }, [activeId])

  /** Сразу после отпускания указателя — не ждать полный debounce, чтобы другие быстрее увидели перенос. */
  const flushIconsPatchAfterPointerUp = useCallback(() => {
    const hadDrag = dragRef.current !== null
    dragRef.current = null
    if (!hadDrag || !canEdit || !activeId) return
    window.setTimeout(() => {
      pendingIconsRef.current = [...markersRef.current]
      if (autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current)
        autosaveTimerRef.current = null
      }
      void flushIconsPatch()
    }, 0)
  }, [activeId, canEdit, flushIconsPatch])

  useEffect(() => {
    if (!activeId || !loadedRef.current || loading) return
    setSaveState((prev) => (prev === 'dirty' ? prev : 'dirty'))
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current)
    pendingIconsRef.current = [...markers]
    autosaveTimerRef.current = window.setTimeout(() => {
      void flushIconsPatch()
    }, 320)
  }, [activeId, loading, markers, flushIconsPatch])

  const save = async () => {
    if (!canEdit) return
    if (!activeId) return
    if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current)
    pendingIconsRef.current = null
    await saveLayout(activeId, layout)
  }

  const createFloor = async () => {
    if (!canEdit) return
    setFloorMenuOpen(false)
    if (activeId) await save()
    setLoading(true)
    setErr(null)
    try {
      const title = window.prompt('Название этажа', `Этаж ${diagrams.length + 1}`)?.trim()
      if (title === undefined) return
      const created = await api.createBlankFloor({ title: title || `Этаж ${diagrams.length + 1}` })
      const rows = await api.diagrams()
      setDiagrams(rows)
      setActiveId(created.id)
      await loadDiagram(created.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось добавить этаж')
    } finally {
      setLoading(false)
    }
  }

  const renameFloor = async () => {
    if (!canEdit) return
    if (!activeDiagram) return
    const next = renameValue.trim()
    if (!next) return
    try {
      await api.patchDiagram(activeDiagram.id, { title: next })
      const rows = await api.diagrams()
      setDiagrams(rows)
      setRenamingFloor(false)
      setFloorMenuOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось переименовать этаж')
    }
  }

  const deleteFloor = async () => {
    if (!canEdit) return
    setFloorMenuOpen(false)
    if (!activeDiagram) return
    if (diagrams.length <= 1) {
      setErr('Нельзя удалить единственный этаж')
      return
    }
    if (!window.confirm(`Удалить этаж "${activeDiagram.title}"?`)) return
    try {
      await api.deleteDiagram(activeDiagram.id)
      const rows = await api.diagrams()
      setDiagrams(rows)
      const next = rows[0] ?? null
      if (next) {
        setActiveId(next.id)
        await loadDiagram(next.id)
      } else {
        setActiveId(null)
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось удалить этаж')
    }
  }

  const importPng = async (file: File | undefined) => {
    if (!canEdit) return
    if (!file) return
    if (!activeId) {
      setErr('Сначала выберите этаж для импорта фона')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    const hasObjects =
      (layout.icons?.length ?? 0) > 0 ||
      (layout.rooms?.length ?? 0) > 0 ||
      (layout.walls?.length ?? 0) > 0 ||
      (layout.computers?.length ?? 0) > 0
    if (hasObjects) {
      const ok = window.confirm(
        'На текущем этаже уже есть объекты.\n\nФон будет заменен для этого этажа, а объекты останутся на своих координатах. Если размер нового фона отличается, элементы могут визуально сместиться.\n\nПродолжить импорт?',
      )
      if (!ok) {
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }
    }
    setLoading(true)
    setErr(null)
    try {
      await api.replaceDiagramBackgroundPng(activeId, file)
      const rows = await api.diagrams()
      setDiagrams(rows)
      setActiveId(activeId)
      await loadDiagram(activeId)
      setDiagramRefreshKey(Date.now())
      setSaveState('saved')
      setLastSavedAt(Date.now())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось импортировать PNG')
    } finally {
      setLoading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const exportPng = async () => {
    if (!activeId || !svgRef.current) return
    await save()
    try {
      const svgNode = svgRef.current
      const exportSvg = svgNode.cloneNode(true) as SVGSVGElement
      exportSvg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      exportSvg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink')

      // Keep font rendering in exported PNG the same as in app UI.
      exportSvg.querySelectorAll('text').forEach((textNode) => {
        textNode.setAttribute('font-family', 'Inter, system-ui, Segoe UI, Arial, sans-serif')
      })

      // Embed floor background as data URL so PNG export never loses it.
      const bg = exportSvg.querySelector('image')
      if (bg) {
        const rawHref = bg.getAttribute('href') || bg.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
        const fallbackHref = `${api.diagramSvgUrl(activeId)}?v=${Date.now()}`
        const bgHref = rawHref?.trim() || fallbackHref
        try {
          const bgRes = await fetch(bgHref, { credentials: 'include' })
          if (bgRes.ok) {
            const bgBlob = await bgRes.blob()
            const bgDataUrl = await blobToDataUrl(bgBlob)
            bg.setAttribute('href', bgDataUrl)
            bg.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', bgDataUrl)
          }
        } catch {
          // Keep original href if background fetch fails.
        }
      }

      exportSvg.setAttribute('viewBox', `${floorExtent.x} ${floorExtent.y} ${floorExtent.w} ${floorExtent.h}`)
      const bgRect = exportSvg.querySelector('rect')
      if (bgRect) {
        bgRect.setAttribute('x', String(floorExtent.x))
        bgRect.setAttribute('y', String(floorExtent.y))
        bgRect.setAttribute('width', String(floorExtent.w))
        bgRect.setAttribute('height', String(floorExtent.h))
      }

      const serializer = new XMLSerializer()
      const svgText = serializer.serializeToString(exportSvg)
      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      const svgUrl = URL.createObjectURL(svgBlob)
      const img = new Image()
      const vb = floorExtent
      const canvas = document.createElement('canvas')
      const outW = Math.max(1, Math.round(vb.w))
      const outH = Math.max(1, Math.round(vb.h))
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(svgUrl)
        throw new Error('Не удалось подготовить canvas для экспорта PNG')
      }
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Не удалось прочитать SVG для PNG-экспорта'))
        img.src = svgUrl
      })
      ctx.drawImage(img, 0, 0, outW, outH)
      URL.revokeObjectURL(svgUrl)
      canvas.toBlob((blob) => {
        if (!blob) {
          setErr('Не удалось сформировать PNG')
          return
        }
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `sitemap-${activeId}.png`
        a.click()
        URL.revokeObjectURL(url)
      }, 'image/png')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось экспортировать PNG')
    }
  }

  const onCanvasPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!canEdit) return
    const drag = dragRef.current
    if (!drag) return
    const point = svgPoint(event)
    if (!point) return
    const dx = point.x - drag.originX
    const dy = point.y - drag.originY
    setLayout((current) => ({
      ...current,
      icons: (current.icons ?? []).map((m) => {
        if (!drag.markerIds.includes(m.id)) return m
        const start = drag.start[m.id]
        if (!start) return m
        return { ...m, x: start.x + dx, y: start.y + dy }
      }),
    }))
    const t = performance.now()
    if (t - lastIconDragSentMsRef.current < 30) return
    lastIconDragSentMsRef.current = t
    const iconsPayload = drag.markerIds
      .map((id) => {
        const start = drag.start[id]
        return start ? { id, x: start.x + dx, y: start.y + dy } : null
      })
      .filter((v): v is { id: string; x: number; y: number } => v != null)
    if (iconsPayload.length) sendIconDrag(iconsPayload)
  }

  const onSvgPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const pan = panRef.current
    if (pan && event.pointerId === pan.pointerId) {
      const svg = svgRef.current
      if (!svg) return
      if (!pan.engaged) {
        const ddx = event.clientX - pan.startClientX
        const ddy = event.clientY - pan.startClientY
        if (ddx * ddx + ddy * ddy < 9) return
        pan.engaged = true
        pan.lastClientX = event.clientX
        pan.lastClientY = event.clientY
        setIsPanning(true)
        return
      }
      const p0 = clientToSvgPoint(svg, pan.lastClientX, pan.lastClientY)
      const p1 = clientToSvgPoint(svg, event.clientX, event.clientY)
      if (p0 && p1) {
        const dwx = p1.x - p0.x
        const dwy = p1.y - p0.y
        setCameraView((cam) => {
          const fe = floorExtent
          let nx = cam.x - dwx
          let ny = cam.y - dwy
          nx = Math.min(fe.x + fe.w - cam.w, Math.max(fe.x, nx))
          ny = Math.min(fe.y + fe.h - cam.h, Math.max(fe.y, ny))
          return clampCameraZoomToFloorExtent({ x: nx, y: ny, w: cam.w, h: cam.h }, fe)
        })
      }
      pan.lastClientX = event.clientX
      pan.lastClientY = event.clientY
      return
    }
    onCanvasPointerMove(event)
  }

  const onSvgPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    setSelectedIds([])
    panRef.current = {
      pointerId: e.pointerId,
      lastClientX: e.clientX,
      lastClientY: e.clientY,
      startClientX: e.clientX,
      startClientY: e.clientY,
      engaged: false,
    }
    setIsPanning(false)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* already captured */
    }
  }

  const onSvgPointerUpOrCancel = (e: PointerEvent<SVGSVGElement>) => {
    if (panRef.current?.pointerId === e.pointerId) {
      panRef.current = null
      setIsPanning(false)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* */
      }
    }
    flushIconsPatchAfterPointerUp()
  }

  const markerPointerDown = (event: PointerEvent<SVGGElement>, id: string) => {
    if (!canEdit) {
      event.stopPropagation()
      setSelectedIds([id])
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = svgPoint(event)
    if (!point) return
    const multi = event.shiftKey || event.ctrlKey || event.metaKey
    let nextSelection: string[]
    if (multi) {
      const exists = selectedIds.includes(id)
      nextSelection = exists ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]
      if (!nextSelection.length) {
        setSelectedIds([])
        dragRef.current = null
        return
      }
    } else {
      nextSelection = selectedIds.includes(id) ? selectedIds : [id]
    }
    setSelectedIds(nextSelection)
    const start: Record<string, { x: number; y: number }> = {}
    for (const m of markers) {
      if (nextSelection.includes(m.id)) start[m.id] = { x: m.x, y: m.y }
    }
    dragRef.current = { originX: point.x, originY: point.y, markerIds: nextSelection, start }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5">
          <IconGraph className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">Карта здания</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
            Схема этажа: загрузите PNG-фон → разместите оборудование → настройте свойства справа → экспортируйте карту.
          </p>
        </div>
      </div>

      {err ? <div className="app-alert app-alert-error mb-4">{err}</div> : null}
      {!canEdit ? (
        <div className="app-alert app-alert-warning mb-4">
          Режим просмотра: перемещение и редактирование объектов доступны только редактору и администратору.
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-sm">
            <span className="pl-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Этажи</span>
            <select
              value={activeId ?? ''}
              onChange={(e) => {
                const id = Number(e.target.value)
                if (!Number.isFinite(id)) return
                if (autosaveTimerRef.current) window.clearTimeout(autosaveTimerRef.current)
                setActiveId(id)
                void loadDiagram(id)
              }}
              className="h-9 min-w-[12rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] outline-none transition focus:border-[var(--color-primary)]"
            >
              {diagrams.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>
          <div className="relative" ref={floorMenuRef}>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 text-sm font-semibold text-[var(--color-fg)] shadow-sm transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
              onClick={() => setFloorMenuOpen((v) => !v)}
              aria-expanded={floorMenuOpen}
              aria-haspopup="menu"
              disabled={!canEdit}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 text-[var(--color-fg-subtle)]"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.9"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="12" cy="12" r="2.6" />
                <path d="M19 12a7 7 0 0 0-.07-.99l2.02-1.57-1.9-3.3-2.45.76a7.3 7.3 0 0 0-1.71-.99l-.37-2.54h-3.8l-.37 2.54c-.6.23-1.17.56-1.7.99l-2.46-.76-1.9 3.3 2.02 1.57A7 7 0 0 0 5 12c0 .34.03.67.07.99l-2.02 1.57 1.9 3.3 2.45-.76c.53.43 1.1.76 1.71.99l.37 2.54h3.8l.37-2.54c.6-.23 1.17-.56 1.7-.99l2.46.76 1.9-3.3-2.02-1.57c.04-.32.06-.65.06-.99Z" />
              </svg>
              Настройки этажа
            </button>
            {floorMenuOpen ? (
              <div className="popup-enter absolute left-0 top-11 z-20 min-w-64 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-xl">
                <button
                  type="button"
                  className="w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                  onClick={() => void createFloor()}
                  disabled={!canEdit || loading || saving}
                >
                  Добавить этаж
                </button>
                <button
                  type="button"
                  className="w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                  onClick={() => {
                    if (!activeDiagram) return
                    setRenamingFloor(true)
                    setRenameValue(activeDiagram.title)
                  }}
                  disabled={!canEdit || !activeDiagram || loading}
                >
                  Переименовать текущий
                </button>
                {renamingFloor ? (
                  <form
                    className="mt-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void renameFloor()
                    }}
                  >
                    <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">Новое имя этажа</label>
                    <input
                      className="app-input !min-h-0 !py-2"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoFocus
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <button
                        type="button"
                        className="app-btn app-btn-secondary !min-h-0 !px-2.5 !py-1.5 !text-xs"
                        onClick={() => setRenamingFloor(false)}
                      >
                        Отмена
                      </button>
                      <button
                        type="submit"
                        className="app-btn app-btn-primary !min-h-0 !px-2.5 !py-1.5 !text-xs"
                        disabled={!renameValue.trim()}
                      >
                        Сохранить
                      </button>
                    </div>
                  </form>
                ) : null}
                <button
                  type="button"
                  className="w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--color-primary)] transition hover:bg-[var(--color-primary-muted)] disabled:opacity-60"
                  onClick={() => void deleteFloor()}
                  disabled={!canEdit || !activeDiagram || diagrams.length <= 1 || loading}
                >
                  Удалить текущий
                </button>
              </div>
            ) : null}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png"
            className="hidden"
            onChange={(e) => void importPng(e.target.files?.[0])}
            disabled={!canEdit}
          />
          <button
            type="button"
            className="app-btn app-btn-secondary !h-10"
            onClick={() => fileInputRef.current?.click()}
            disabled={!canEdit}
            title="Шаг 1: загрузите план этажа (PNG)"
          >
            1. Импорт PNG-фона
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary !h-10"
            onClick={() => void exportPng()}
            disabled={!activeId || saving}
            title="Сохранить готовую карту как PNG"
          >
            Экспорт PNG
          </button>
        </div>
      </div>

      <div
        className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,28rem)] xl:gap-4"
        onDragEnter={onLayoutDragEnter}
        onDragOver={onLayoutDragOver}
        onDragLeave={onLayoutDragLeave}
        onDrop={onLayoutDrop}
      >
        <div className="app-card min-w-0 self-start overflow-hidden p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <div className="relative">
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-primary-muted)] px-3 py-2 text-sm font-semibold text-[var(--color-primary)] transition hover:border-[var(--color-primary)]"
                onClick={() => setToolboxOpen((v) => !v)}
                disabled={!canEdit}
                title="Шаг 2: добавить оборудование на карту"
              >
                2. + Объекты
              </button>
              {toolboxOpen ? (
                <div className="popup-enter absolute left-0 top-11 z-20 grid min-w-64 grid-cols-2 gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-xl">
                  {EQUIPMENT.map((item) => (
                    <button
                      key={item.kind}
                      type="button"
                      className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-left text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                      onClick={() => {
                        addMarker(item.kind)
                      }}
                      disabled={!canEdit}
                    >
                      <EquipmentMenuIcon kind={item.kind} />
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input type="checkbox" checked={!showLabels} onChange={(e) => setShowLabels(!e.target.checked)} />
              Скрыть надписи
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={showHoverCard}
                onChange={(e) => setShowHoverCard(e.target.checked)}
              />
              Карточка при наведении
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={outletVis.ethOutlets}
                onChange={(e) => setOutletVisibility({ ethOutlets: e.target.checked })}
              />
              Ethernet-розетки
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={outletVis.phoneOutlets}
                onChange={(e) => setOutletVisibility({ phoneOutlets: e.target.checked })}
              />
              Тел. розетки
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={outletVis.ethCables}
                onChange={(e) => setOutletVisibility({ ethCables: e.target.checked })}
              />
              Кабели Ethernet
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={outletVis.phoneCables}
                onChange={(e) => setOutletVisibility({ phoneCables: e.target.checked })}
              />
              Тел. кабели
            </label>
            <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={exportWithLabels}
                onChange={(e) => setExportWithLabels(e.target.checked)}
              />
              Экспорт с надписями
            </label>
            {user && activeId ? (
              <div
                className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-fg-muted)] shadow-sm"
                title="Одновременное редактирование: список учётных записей с открытой картой здания (live по любому этажу). Пока есть несохранённые правки, чужие изменения сами не подтягиваются."
              >
                <span
                  className="inline-flex shrink-0 items-center"
                  title={liveConnected ? 'Канал live подключён' : 'Нет подключения к live'}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full motion-safe:transition-opacity motion-safe:duration-500 ${
                      liveConnected ? 'bg-emerald-500 motion-safe:animate-pulse' : 'bg-[var(--color-border-strong)]'
                    }`}
                    aria-hidden
                  />
                </span>
                <span className="font-medium text-[var(--color-fg)]">Онлайн</span>
                <span className="flex min-w-0 flex-wrap items-center gap-1">
                  {peers.length ? (
                    peers.map((p) => (
                      <span
                        key={p.user_id}
                        className="inline-flex max-w-[9rem] truncate rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)] ring-1 ring-[var(--color-border)]"
                        title={(p.full_name || '').trim() || p.username}
                      >
                        {p.username}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11px] text-[var(--color-fg-subtle)]">—</span>
                  )}
                </span>
              </div>
            ) : null}
            </div>
            <div
              className="shrink-0 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-right text-[11px] text-[var(--color-fg-muted)] transition-colors duration-500 ease-out"
              title="Автосохранение позиций объектов на карте"
            >
              {`Автосохр.: ${lastSavedAt ? new Date(lastSavedAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}`}
            </div>
          </div>

          <div className="relative h-[min(72vh,820px)] min-h-[520px] bg-[var(--color-surface-muted)]">
            <div className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] shadow-sm">
              ЛКМ тащить — сдвиг · колёсико — масштаб · клик по объекту — свойства справа
            </div>
            {loading || !activeDiagram ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">Загрузка карты…</div>
            ) : (
              <svg
                ref={svgRef}
                viewBox={`${cameraView.x} ${cameraView.y} ${cameraView.w} ${cameraView.h}`}
                className={`h-full w-full touch-none select-none ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
                onPointerDown={onSvgPointerDown}
                onPointerMove={onSvgPointerMove}
                onPointerUp={onSvgPointerUpOrCancel}
                onPointerCancel={onSvgPointerUpOrCancel}
              >
                <rect x={cameraView.x} y={cameraView.y} width={cameraView.w} height={cameraView.h} fill="#f8fafc" />
                {activeId ? (
                  <image
                    href={`${api.diagramSvgUrl(activeId)}?v=${diagramRefreshKey}`}
                    x={floorExtent.x}
                    y={floorExtent.y}
                    width={floorExtent.w}
                    height={floorExtent.h}
                    preserveAspectRatio="xMidYMid meet"
                  />
                ) : null}
                <g pointerEvents="none">
                  {outletCableSegments.map((seg) => {
                    const showCable = seg.kind === 'ethernet' ? outletVis.ethCables : outletVis.phoneCables
                    if (!showCable) return null
                    return (
                      <line
                        key={seg.id}
                        x1={seg.x1}
                        y1={seg.y1}
                        x2={seg.x2}
                        y2={seg.y2}
                        stroke={seg.kind === 'ethernet' ? 'rgb(16,185,129)' : 'rgb(245,158,11)'}
                        strokeWidth={2.5}
                        strokeDasharray="7 5"
                        strokeLinecap="round"
                        opacity={0.88}
                        vectorEffect="non-scaling-stroke"
                      />
                    )
                  })}
                </g>
                {visibleMarkers.map((marker) => {
                  const isActive = selectedIds.includes(marker.id) || marker.id === hoveredId
                  const scale = marker.scale ?? 1
                  const titleLines = splitLabelLines(markerTitle(marker))
                  const { x: mx, y: my } = markerDisplayPos(marker)
                  const placePhotoCount = parsePlacePhotosJson(marker.meta?.place_photos_json).length
                  return (
                    <g
                      key={marker.id}
                      transform={`translate(${mx} ${my}) scale(${scale})`}
                      className={canEdit ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'}
                      onPointerDown={(e) => markerPointerDown(e, marker.id)}
                      onPointerUp={flushIconsPatchAfterPointerUp}
                      onPointerCancel={flushIconsPatchAfterPointerUp}
                      onPointerEnter={() => setHoveredId(marker.id)}
                      onPointerLeave={() => setHoveredId(null)}
                    >
                      {marker.kind === 'text' ? (
                        <text
                          textAnchor="middle"
                          dominantBaseline="middle"
                          className="fill-slate-950 text-[18px] font-bold"
                          style={{
                            paintOrder: 'stroke',
                            stroke: 'rgba(255,255,255,0.82)',
                            strokeWidth: 5,
                            fontFamily: 'Inter, system-ui, Segoe UI, Arial, sans-serif',
                            fontSize: 18,
                            fontWeight: 700,
                          }}
                        >
                          {showLabels ? markerTitle(marker) : ''}
                        </text>
                      ) : (
                        <>
                          <circle
                            r={markerCircleRadius(marker.kind)}
                            fill={markerCircleFill(marker.kind)}
                            stroke={isActive ? 'rgb(250,204,21)' : 'rgba(15,23,42,0.85)'}
                            strokeWidth={isActive ? 4 : 1.5}
                            vectorEffect="non-scaling-stroke"
                          />
                          <EquipmentGlyph kind={marker.kind} />
                          {showLabels ? (
                            <text
                              y={isOutletKind(marker.kind) ? 21 : 38}
                              textAnchor="middle"
                              className="fill-slate-950 text-[12px] font-semibold"
                              style={{
                                paintOrder: 'stroke',
                                stroke: 'rgba(255,255,255,0.86)',
                                strokeWidth: 4,
                                fontFamily: 'Inter, system-ui, Segoe UI, Arial, sans-serif',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {titleLines.map((line, idx) => (
                                <tspan key={`${marker.id}-title-${idx}`} x="0" dy={idx === 0 ? 0 : 12}>
                                  {line}
                                </tspan>
                              ))}
                            </text>
                          ) : null}
                        </>
                      )}
                      {placePhotoCount > 0 ? (
                        <g transform="translate(20 -20)" pointerEvents="none">
                          <title>Есть фото с места установки</title>
                          <circle r="7" fill="white" stroke="rgb(37,99,235)" strokeWidth="1.5" />
                          <rect
                            x="-4"
                            y="-2.5"
                            width="8"
                            height="5.5"
                            rx="0.9"
                            fill="none"
                            stroke="rgb(37,99,235)"
                            strokeWidth="1.2"
                          />
                          <circle cx="1.5" cy="-1" r="0.85" fill="rgb(37,99,235)" />
                        </g>
                      ) : null}
                    </g>
                  )
                })}
                {hoveredMarker && hoveredDisplayPos && showHoverCard ? (() => {
                  const hoverTransform = `translate(${hoveredDisplayPos.x + 28} ${hoveredDisplayPos.y - 64})`
                  const textFamily = 'Inter, system-ui, Segoe UI, Arial, sans-serif'

                  if (hoveredMarker.kind === 'pc') {
                    const eth = (hoveredMarker.meta?.ethernet_outlet ?? '').trim() || '—'
                    const phone = (hoveredMarker.meta?.phone_outlet ?? '').trim() || '—'
                    const ip = (hoveredMarker.meta?.ip ?? '').trim() || '—'
                    const os = hoveredMarker.meta?.os_name || hoveredLinkedPc?.os_name || '—'
                    const boxH = 96
                    return (
                      <g transform={hoverTransform} pointerEvents="none">
                        <rect width="256" height={boxH} rx="12" fill="rgba(15,23,42,0.92)" />
                        <text x="14" y="24" fill="white" fontSize="14" fontWeight="700" fontFamily={textFamily}>
                          {markerTitle(hoveredMarker)}
                        </text>
                        <text x="14" y="46" fill="rgba(255,255,255,0.78)" fontSize="12" fontFamily={textFamily}>
                          {`Розетки: Eth ${eth} · тел. ${phone}`}
                        </text>
                        <text x="14" y="66" fill="rgba(255,255,255,0.72)" fontSize="11" fontFamily={textFamily}>
                          {`IP: ${ip}`}
                        </text>
                        <text x="14" y="84" fill="rgba(255,255,255,0.78)" fontSize="12" fontFamily={textFamily}>
                          {`ОС: ${os}`}
                        </text>
                      </g>
                    )
                  }

                  if (isOutletKind(hoveredMarker.kind)) {
                    const num = outletNumber(hoveredMarker) || '—'
                    const pcId = (hoveredMarker.meta?.connected_pc_id ?? '').trim()
                    const linkedPc = pcId ? markers.find((m) => m.id === pcId && m.kind === 'pc') : null
                    const boxH = 78
                    return (
                      <g transform={hoverTransform} pointerEvents="none">
                        <rect width="256" height={boxH} rx="12" fill="rgba(15,23,42,0.92)" />
                        <text x="14" y="24" fill="white" fontSize="14" fontWeight="700" fontFamily={textFamily}>
                          {KIND_LABEL[hoveredMarker.kind]}
                        </text>
                        <text x="14" y="46" fill="rgba(255,255,255,0.78)" fontSize="12" fontFamily={textFamily}>
                          {`№ ${num}`}
                        </text>
                        <text x="14" y="66" fill="rgba(255,255,255,0.72)" fontSize="11" fontFamily={textFamily}>
                          {`Кабель → ${linkedPc ? markerTitle(linkedPc) : 'не подключён'}`}
                        </text>
                      </g>
                    )
                  }

                  const hoverPhoto = firstPlacePhotoDataUrl(hoveredMarker.meta?.place_photos_json)
                  const hasPhoto = Boolean(hoverPhoto)
                  const hoverPhotoSlotH = 88
                  const hoverPhotoTop = 12
                  const hoverPhotoGapBelow = 14
                  const baseH = hoveredLinkedPc ? 112 : 96
                  const photoExtra = 58 + (hoverPhotoSlotH - 52)
                  const boxH = hasPhoto ? baseH + photoExtra : baseH
                  const tTitle = hasPhoto ? hoverPhotoTop + hoverPhotoSlotH + hoverPhotoGapBelow : 24
                  const tOs = hasPhoto ? tTitle + 21 : 45
                  const tIp = hasPhoto ? tOs + 19 : 63
                  const tRam = hasPhoto ? tIp + 19 : 82
                  return (
                    <g transform={hoverTransform} pointerEvents="none">
                      <defs>
                        <clipPath id={hoverPhotoClipId}>
                          <rect x="14" y="12" width="228" height={hoverPhotoSlotH} rx="8" />
                        </clipPath>
                      </defs>
                      <rect width="256" height={boxH} rx="12" fill="rgba(15,23,42,0.92)" />
                      {hasPhoto && hoverPhoto ? (
                        <image
                          href={hoverPhoto}
                          x="14"
                          y="12"
                          width="228"
                          height={hoverPhotoSlotH}
                          preserveAspectRatio="xMidYMid meet"
                          clipPath={`url(#${hoverPhotoClipId})`}
                        />
                      ) : null}
                      <text x="14" y={tTitle} fill="white" fontSize="14" fontWeight="700" fontFamily={textFamily}>
                        {markerTitle(hoveredMarker)}
                      </text>
                      <text x="14" y={tOs} fill="rgba(255,255,255,0.78)" fontSize="12" fontFamily={textFamily}>
                        OS: {hoveredMarker.meta?.os_name || hoveredLinkedPc?.os_name || '—'}
                      </text>
                      <text x="14" y={tIp} fill="rgba(255,255,255,0.62)" fontSize="11" fontFamily={textFamily}>
                        IP: {hoveredMarker.meta?.ip || '—'} · MAC: {hoveredMarker.meta?.mac || '—'}
                      </text>
                      {hoveredLinkedPc ? (
                        <text x="14" y={tRam} fill="rgba(255,255,255,0.80)" fontSize="11" fontFamily={textFamily}>
                          {`RAM: ${hoveredLinkedPc.ram_gb != null ? `${hoveredLinkedPc.ram_gb} GB` : '—'}`}
                        </text>
                      ) : null}
                    </g>
                  )
                })() : null}
              </svg>
            )}
          </div>
        </div>

        <aside className="min-h-0 min-w-0 self-start rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-sm max-h-[min(88dvh,calc(100dvh-9.5rem))] overflow-y-auto overscroll-contain pr-0.5 [scrollbar-gutter:stable]">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] pb-2">
            <div>
              <div className="text-sm font-semibold text-[var(--color-fg)]">Свойства</div>
              <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                {selectedIds.length > 1
                  ? `Выбрано объектов: ${selectedIds.length}`
                  : selectedMarker
                    ? markerTitle(selectedMarker)
                    : 'Объект не выбран'}
              </div>
            </div>
          </div>
          {!selectedMarker ? (
            <div className="mt-3 space-y-3">
              <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-4 text-sm text-[var(--color-fg-muted)]">
                {selectedIds.length > 1
                  ? 'Можно перетаскивать выбранные объекты группой. Для выбора нескольких используйте Ctrl/Shift + клик.'
                  : 'Выберите объект на карте или добавьте новый элемент сверху.'}
              </div>
              <ol className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-3 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">1.</span> Выберите этаж и при
                  необходимости загрузите PNG-фон.
                </li>
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">2.</span> Нажмите «+ Объекты» и
                  добавьте ПК, розетку или другое оборудование.
                </li>
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">3.</span> Кликните объект —
                  справа появятся свойства; перетащите его на схему.
                </li>
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">4.</span> Экспортируйте готовую
                  карту кнопкой «Экспорт PNG».
                </li>
              </ol>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Тип</span>
                <select
                  value={selectedMarker.kind}
                  onChange={(e) => updateMarker(selectedMarker.id, { kind: e.target.value as FloorIconKind })}
                  className="app-input mt-0.5 !min-h-0 !py-2"
                  disabled={!canEdit}
                >
                  {EQUIPMENT.map((item) => (
                    <option key={item.kind} value={item.kind}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Название</span>
                <input
                  value={selectedMarker.label ?? ''}
                  onChange={(e) => updateMarker(selectedMarker.id, { label: e.target.value })}
                  className="app-input mt-0.5 !min-h-0 !py-2"
                  placeholder="Например: Серверная"
                  disabled={!canEdit}
                />
              </label>

              {isOutletKind(selectedMarker.kind) ? (
                <div className="rounded-lg border border-slate-200/90 bg-slate-50/60 px-2.5 py-2 space-y-2">
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                      Номер розетки
                    </span>
                    <input
                      value={selectedMarker.meta?.outlet_number ?? ''}
                      onChange={(e) =>
                        updateOutletMarker(selectedMarker.id, {
                          meta: { ...selectedMarker.meta, outlet_number: e.target.value },
                        })
                      }
                      className="mt-0.5 h-9 w-full rounded-lg border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                      placeholder="Например: 12-A"
                      disabled={!canEdit}
                    />
                  </label>
                  <div className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                      Кабель к ПК на карте
                    </span>
                    <FloorPcMarkerPicker
                      key={selectedMarker.id}
                      pcMarkers={pcMarkersOnFloor}
                      pcDirectory={pcDirectory}
                      valueId={selectedMarker.meta?.connected_pc_id ?? ''}
                      disabled={!canEdit}
                      onChange={(id) =>
                        updateOutletMarker(
                          selectedMarker.id,
                          { meta: { ...selectedMarker.meta, connected_pc_id: id } },
                          { prevConnectedPcId: selectedMarker.meta?.connected_pc_id ?? '' },
                        )
                      }
                    />
                    {pcMarkersOnFloor.length === 0 ? (
                      <p className="mt-1 text-[11px] text-slate-500">Сначала добавьте объект «ПК» на этот этаж.</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {selectedMarker.kind === 'pc' ? (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    Привязка к парку ПК
                  </span>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="h-8 rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-60"
                      onClick={() => setPcLinkDialogOpen(true)}
                      disabled={!canEdit}
                    >
                      {selectedMarker.meta?.computer_id ? 'Сменить привязку' : 'Привязать ПК'}
                    </button>
                    {selectedMarker.meta?.computer_id ? (
                      <button
                        type="button"
                        className="h-8 rounded-lg border border-blue-200 bg-white px-2.5 text-xs font-medium text-blue-700 transition hover:bg-blue-50 disabled:opacity-60"
                        onClick={() =>
                          updateMarker(selectedMarker.id, {
                            meta: {
                              ...selectedMarker.meta,
                              computer_id: '',
                              os_name: '',
                              cpu: '',
                              ram_gb: '',
                              manufacturer: '',
                              model: '',
                            },
                          })
                        }
                        disabled={!canEdit}
                      >
                        Снять
                      </button>
                    ) : null}
                  </div>
                  {selectedMarker.meta?.computer_id ? (
                    <div className="mt-1.5 space-y-0.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] leading-snug text-slate-700">
                      <div>ПК: {selectedLinkedPc?.hostname || selectedMarker.meta.computer_id}</div>
                      <div>Внутренний номер: {selectedMarker.meta.employee_extension || '—'}</div>
                      <div>
                        Розетки: Ethernet {selectedMarker.meta.ethernet_outlet || '—'} · тел.{' '}
                        {selectedMarker.meta.phone_outlet || '—'}
                      </div>
                      <div>OS: {selectedMarker.meta.os_name || '—'}</div>
                      <div>CPU: {selectedMarker.meta.cpu || '—'}</div>
                      <div>RAM: {selectedMarker.meta.ram_gb ? `${selectedMarker.meta.ram_gb} GB` : '—'}</div>
                      <div>
                        HW: {selectedMarker.meta.manufacturer || '—'} {selectedMarker.meta.model || ''}
                      </div>
                      <div>Теги: {selectedLinkedPc?.tags?.map((t) => t.name).join(', ') || '—'}</div>
                      <button
                        type="button"
                        className="mt-1.5 rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-100"
                        onClick={() => {
                          const pcId = Number(selectedMarker.meta?.computer_id)
                          if (!Number.isFinite(pcId) || pcId <= 0) return
                          setPcDetailLoading(true)
                          setPcDetail(null)
                          void api
                            .computer(pcId)
                            .then((detail) => {
                              setPcDetail(detail)
                              setPcInfoSwFilter('')
                              setPcInfoModalOpen(true)
                            })
                            .catch(() => setPcDetail(null))
                            .finally(() => setPcDetailLoading(false))
                        }}
                      >
                        {pcDetailLoading ? 'Загрузка...' : 'Узнать больше'}
                      </button>
                    </div>
                  ) : null}
                </label>
              ) : null}

              {selectedMarker.kind === 'pc' ? (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                    Внутренний номер сотрудника
                  </span>
                  <input
                    value={selectedMarker.meta?.employee_extension ?? ''}
                    onChange={(e) =>
                      updateMarker(selectedMarker.id, {
                        meta: { ...selectedMarker.meta, employee_extension: e.target.value },
                      })
                    }
                    className="mt-0.5 h-9 w-full rounded-lg border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                    placeholder="Например: 2431"
                    disabled={!canEdit}
                  />
                </label>
              ) : null}

              {selectedMarker.kind === 'pc' ? (
                <div className="rounded-lg border border-slate-200/90 bg-slate-50/60 px-2.5 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Розетки</div>
                  <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-1.5">
                    <label className="block min-w-0">
                      <span className="text-[11px] font-medium text-slate-500">Ethernet</span>
                      <input
                        value={selectedMarker.meta?.ethernet_outlet ?? ''}
                        onChange={(e) =>
                          updateMarker(selectedMarker.id, {
                            meta: { ...selectedMarker.meta, ethernet_outlet: e.target.value },
                          })
                        }
                        className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                        placeholder="Напр. 12-A"
                        disabled={!canEdit}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="text-[11px] font-medium text-slate-500">Телефон</span>
                      <input
                        value={selectedMarker.meta?.phone_outlet ?? ''}
                        onChange={(e) =>
                          updateMarker(selectedMarker.id, {
                            meta: { ...selectedMarker.meta, phone_outlet: e.target.value },
                          })
                        }
                        className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                        placeholder="Напр. 08-B"
                        disabled={!canEdit}
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-3 gap-1.5">
                <label className="block min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">X</span>
                  <input
                    type="number"
                    value={Math.round(selectedMarker.x)}
                    onChange={(e) => updateMarker(selectedMarker.id, { x: Number(e.target.value) || 0 })}
                    className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                    disabled={!canEdit}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Y</span>
                  <input
                    type="number"
                    value={Math.round(selectedMarker.y)}
                    onChange={(e) => updateMarker(selectedMarker.id, { y: Number(e.target.value) || 0 })}
                    className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                    disabled={!canEdit}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Размер</span>
                  <input
                    type="number"
                    min={0.6}
                    max={2.2}
                    step={0.1}
                    value={Math.round(((selectedMarker.scale ?? 1) + Number.EPSILON) * 10) / 10}
                    onChange={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isFinite(v)) return
                      updateMarker(selectedMarker.id, { scale: Math.min(2.2, Math.max(0.6, v)) })
                    }}
                    className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                    disabled={!canEdit}
                  />
                </label>
              </div>

              {!isOutletKind(selectedMarker.kind) ? (
                <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
                  <label className="block min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">IP</span>
                    <input
                      value={selectedMarker.meta?.ip ?? ''}
                      onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, ip: e.target.value } })}
                      className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                      placeholder="10.0.0.1"
                      disabled={!canEdit}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">MAC</span>
                    <input
                      value={selectedMarker.meta?.mac ?? ''}
                      onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, mac: e.target.value } })}
                      className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-neutral-200 bg-white px-2.5 font-mono text-[13px] leading-snug tracking-tight text-neutral-900 outline-none transition focus:border-neutral-400"
                      placeholder="AA:BB:CC:DD:EE:FF"
                      disabled={!canEdit}
                      spellCheck={false}
                    />
                  </label>
                </div>
              ) : null}

              {!isOutletKind(selectedMarker.kind) ? (
              <div className="grid min-w-0 grid-cols-[minmax(8.25rem,0.4fr)_minmax(0,1fr)] gap-3">
                <div
                  ref={placePhotosSectionRef}
                  className={`min-w-0 rounded-lg transition-shadow ${
                    photoFileDragOverLayout ? 'ring-2 ring-sky-500 ring-offset-1 ring-offset-white' : ''
                  }`}
                >
                  <div className="relative z-40 mb-1 min-h-5 pr-6">
                    <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">
                      Фото с места установки
                    </span>
                    <span className="group/tooltip absolute right-0 top-0 inline-flex">
                      <button
                        type="button"
                        className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-white text-[10px] font-bold leading-none text-slate-600 outline-none transition hover:border-slate-400 hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1"
                        aria-describedby={placePhotosHelpTipId}
                        aria-label="Справка: фото с места установки"
                      >
                        i
                      </button>
                      <span
                        id={placePhotosHelpTipId}
                        role="tooltip"
                        className="pointer-events-none absolute right-full top-1/2 z-40 mr-2 w-max max-w-[min(19rem,100%)] -translate-y-1/2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-slate-600 opacity-0 shadow-lg transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100"
                      >
                        {placePhotosHelpText}
                      </span>
                    </span>
                  </div>
                  <input
                    ref={placePhotoInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    onChange={onPickPlacePhotos}
                  />
                  <button
                    type="button"
                    className="mt-1.5 h-8 w-full rounded-lg border border-neutral-200 bg-white px-2.5 text-xs font-medium text-neutral-800 transition hover:bg-neutral-50 disabled:opacity-60"
                    onClick={() => placePhotoInputRef.current?.click()}
                    disabled={!canEdit || placePhotoBusy || selectedPlacePhotos.length >= MAX_PLACE_PHOTOS}
                  >
                    {placePhotoBusy ? 'Обработка…' : 'Добавить фото'}
                  </button>
                  {selectedPlacePhotos.length >= MAX_PLACE_PHOTOS ? (
                    <p className="mt-0.5 text-[11px] text-amber-700">Достигнут лимит фото для этого объекта.</p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap content-start gap-2">
                    {selectedPlacePhotos.map((ph) => (
                      <div
                        key={ph.id}
                        className="w-[7.25rem] shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-1.5 shadow-sm"
                      >
                        <button
                          type="button"
                          className="relative flex h-32 w-full items-center justify-center overflow-hidden rounded-md bg-slate-900/5 ring-1 ring-inset ring-black/5"
                          onClick={() => setPhotoLightboxUrl(ph.dataUrl)}
                        >
                          <img
                            src={ph.dataUrl}
                            alt=""
                            className="max-h-full max-w-full object-contain"
                            loading="lazy"
                          />
                          <span className="absolute bottom-1 right-1 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
                            Открыть
                          </span>
                        </button>
                        <input
                          value={ph.caption}
                          onChange={(e) => setPlacePhotoCaption(ph.id, e.target.value)}
                          className="mt-1 h-7 w-full rounded-md border border-neutral-200 bg-white px-1.5 text-[11px] text-neutral-900 outline-none focus:border-neutral-400"
                          placeholder="Подпись"
                          disabled={!canEdit}
                        />
                        <button
                          type="button"
                          className="mt-1 w-full rounded-md border border-blue-100 bg-white py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
                          onClick={() => removePlacePhoto(ph.id)}
                          disabled={!canEdit}
                        >
                          Удалить
                        </button>
                      </div>
                    ))}
                  </div>
                </div>

                <label className="block min-h-[8.5rem] min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Комментарий</span>
                  <textarea
                    value={selectedMarker.meta?.notes ?? ''}
                    onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, notes: e.target.value } })}
                    className="mt-0.5 min-h-[7.5rem] w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                    placeholder="Где смонтировано, как добраться, особенности доступа, ответственный…"
                    disabled={!canEdit}
                  />
                </label>
              </div>
              ) : (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-slate-400">Комментарий</span>
                  <textarea
                    value={selectedMarker.meta?.notes ?? ''}
                    onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, notes: e.target.value } })}
                    className="mt-0.5 min-h-[4.5rem] w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-1.5 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                    placeholder="Расположение в кабинете, шкаф, патч-панель…"
                    disabled={!canEdit}
                  />
                </label>
              )}

              <button
                type="button"
                className="w-full rounded-lg border border-blue-100 bg-white px-2.5 py-1.5 text-sm font-medium text-blue-600 transition hover:border-blue-200 hover:bg-blue-50"
                onClick={deleteSelected}
                disabled={!canEdit}
              >
                Удалить объект
              </button>
            </div>
          )}
        </aside>
      </div>
      {photoLightboxUrl ? (
        <div
          role="presentation"
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-black/80 p-4"
          onClick={() => setPhotoLightboxUrl(null)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full border border-white/30 bg-white/10 px-3 py-1.5 text-sm font-medium text-white backdrop-blur hover:bg-white/20"
            onClick={() => setPhotoLightboxUrl(null)}
          >
            Закрыть
          </button>
          <img
            src={photoLightboxUrl}
            alt=""
            className="max-h-[90vh] max-w-[min(1200px,96vw)] rounded-xl object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : null}
      {pcLinkDialogOpen && selectedMarker?.kind === 'pc' ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_70px_-24px_rgba(2,6,23,0.5)]">
            <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-neutral-950">Привязка к парку ПК</div>
                <div className="text-xs text-slate-500">Название объекта на карте не изменяется</div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
                onClick={() => setPcLinkDialogOpen(false)}
              >
                Закрыть
              </button>
            </div>
            <div className="p-4">
              <input
                value={pcLinkQuery}
                onChange={(e) => setPcLinkQuery(e.target.value)}
                className="h-10 w-full rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 outline-none transition focus:border-neutral-400"
                placeholder="Введите начало: hostname / serial / model"
                autoFocus
              />
              <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                {filteredPcDirectory.map((pc) => (
                  <button
                    key={pc.id}
                    type="button"
                    className="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-left text-sm text-neutral-800 transition hover:bg-neutral-50"
                    onClick={() => {
                      updateMarker(selectedMarker.id, {
                        meta: {
                          ...selectedMarker.meta,
                          computer_id: String(pc.id),
                          employee_extension: selectedMarker.meta?.employee_extension ?? '',
                          os_name: pc.os_name ?? '',
                          cpu: pc.cpu ?? '',
                          ram_gb: pc.ram_gb != null ? String(pc.ram_gb) : '',
                          manufacturer: pc.manufacturer ?? '',
                          model: pc.model ?? '',
                        },
                      })
                      setPcLinkDialogOpen(false)
                    }}
                  >
                    <div className="font-semibold">{pc.hostname}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {pc.os_name || 'OS —'} · RAM {pc.ram_gb != null ? `${pc.ram_gb} GB` : '—'} · SN {pc.serial_number || '—'}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">Теги: {pc.tags?.map((t) => t.name).join(', ') || '—'}</div>
                  </button>
                ))}
                {filteredPcDirectory.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500">
                    Ничего не найдено
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {pcInfoModalOpen && pcDetail ? (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-900/40 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal
          onClick={() => setPcInfoModalOpen(false)}
        >
          <div
            className="app-card flex max-h-[100dvh] w-full max-w-none flex-col overflow-y-auto overscroll-contain rounded-none border-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] shadow-none ring-0 sm:max-h-[min(96vh,calc(100vh-0.5rem))] sm:max-w-[min(1500px,calc(100vw-1rem))] sm:rounded-2xl sm:border sm:border-slate-200/90 sm:p-6 sm:pt-6 sm:shadow-2xl sm:shadow-slate-900/15 sm:ring-1 sm:ring-white/40 lg:p-8 lg:pt-8"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-4">
              <div className="min-w-0 pr-2">
                <h2 className="text-xl font-semibold text-slate-900">{pcDetail.hostname}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {pcDetail.manufacturer} {pcDetail.model} · {pcDetail.serial_number ?? 'нет серийника'}
                  {pcDetail.location ? ` · ${pcDetail.location}` : ''}
                </p>
              </div>
              <button
                type="button"
                className="group shrink-0 rounded-xl border-2 border-slate-300 bg-white p-2.5 text-slate-600 shadow-md shadow-slate-900/10 ring-2 ring-slate-200/80 transition hover:border-blue-400 hover:bg-blue-50 hover:text-blue-700 hover:ring-blue-200/90"
                onClick={() => setPcInfoModalOpen(false)}
                aria-label="Закрыть"
              >
                <IconClose className="h-6 w-6" />
              </button>
            </div>

            <div className="mt-4 grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-8">
              <section className="flex min-w-0 flex-col">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Система и железо</h3>
                <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 sm:gap-x-4 sm:gap-y-3">
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">ОС</dt>
                    <dd className="break-words text-slate-900">
                      {pcDetail.os_name ?? '—'} {pcDetail.os_version ? <span className="text-slate-600">({pcDetail.os_version})</span> : null}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">Процессор (CPU)</dt>
                    <dd className="break-words text-slate-900">{pcDetail.cpu ?? '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">ОЗУ</dt>
                    <dd className="text-slate-900">{pcDetail.ram_gb != null ? `${Math.round(pcDetail.ram_gb)} ГБ` : '—'}</dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-slate-500">GPU</dt>
                    <dd className="break-words text-slate-900">{pcDetail.gpu_name ?? '—'}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">Материнская плата</dt>
                    <dd className="break-words text-slate-900">
                      {pcDetail.motherboard_product || pcDetail.motherboard_manufacturer
                        ? `${pcDetail.motherboard_manufacturer ? `${pcDetail.motherboard_manufacturer} · ` : ''}${pcDetail.motherboard_product ?? '—'}`
                        : '—'}
                    </dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">MAC</dt>
                    <dd className="font-mono text-slate-700">{pcDetail.mac_primary ?? '—'}</dd>
                  </div>
                  <div className="min-w-0 sm:col-span-2">
                    <dt className="text-slate-500">Последний отчёт</dt>
                    <dd className="text-slate-900">{fmtDate(pcDetail.last_report_at)}</dd>
                  </div>
                </dl>
              </section>

              <section className="flex min-w-0 flex-col border-t border-slate-200/80 pt-4 lg:border-l lg:border-t-0 lg:border-slate-200/80 lg:pl-8 lg:pt-0">
                <h3 className="shrink-0 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Диски</h3>
                {(pcDetail.disks?.length ?? 0) > 0 ? (
                  <div className="mt-2 flex flex-wrap content-start gap-2">
                    {(pcDetail.disks ?? []).map((d, i) => (
                      <div key={`${d.mount}-${i}`} className="rounded-lg border border-slate-200/90 bg-white px-3 py-2 text-sm shadow-sm ring-1 ring-slate-100/80">
                        <span className="font-mono font-semibold text-slate-900">{d.mount}</span>
                        <span className="ml-2 text-slate-700">{d.total_gb != null ? `${d.total_gb.toFixed(1)} ГБ` : '—'}</span>
                        <span className="ml-2 text-slate-500">своб.</span>
                        <span className="ml-1 font-mono text-slate-800">{d.free_gb != null ? `${d.free_gb.toFixed(1)} ГБ` : '—'}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">Нет данных по дискам</p>
                )}
              </section>
            </div>

            <div className="mt-6">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Теги</h3>
              <div className="mt-2 flex flex-wrap gap-1">
                {pcDetail.tags.length === 0 ? (
                  <span className="text-sm text-slate-500">—</span>
                ) : (
                  pcDetail.tags.map((t) => (
                    <span key={t.id} className="rounded-full bg-zinc-50 px-2.5 py-1 text-xs text-neutral-900 ring-1 ring-zinc-200/80">
                      {t.name}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-8">
              <section className="flex min-w-0 flex-col">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Установленное ПО</h3>
                <input
                  type="search"
                  placeholder="Поиск в списке ПО…"
                  value={pcInfoSwFilter}
                  onChange={(e) => setPcInfoSwFilter(e.target.value)}
                  className="mt-2 w-full rounded-xl border border-slate-200/90 bg-slate-50/50 px-3 py-2.5 text-sm text-slate-900 transition placeholder:text-slate-400 focus:border-zinc-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                />
                <p className="mt-1 text-xs text-slate-500">Показано: {filteredPcSoftware.length} из {pcDetail.software.length}</p>
                <ul className="mt-2 max-h-[min(70vh,32rem)] min-h-[12rem] overflow-y-auto rounded-xl border border-slate-200/90 bg-slate-50/80 text-sm">
                  {filteredPcSoftware.length === 0 ? (
                    <li className="px-3 py-4 text-slate-500">Нет совпадений</li>
                  ) : (
                    filteredPcSoftware.map((s, i) => (
                      <li key={`${s.name}-${i}`} className="border-b border-slate-100 px-3 py-2.5 last:border-0">
                        <span className="text-slate-900">{s.name}</span>
                        {s.version ? <span className="ml-2 font-mono text-[13px] text-slate-600">{s.version}</span> : null}
                      </li>
                    ))
                  )}
                </ul>
              </section>

              <section className="flex min-w-0 flex-col border-t border-slate-200/80 pt-4 lg:border-l lg:border-t-0 lg:border-slate-200/80 lg:pl-8 lg:pt-0">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Периферия (PnP)</h3>
                <ul className="mt-2 max-h-[min(70vh,32rem)] min-h-[12rem] overflow-y-auto rounded-xl border border-zinc-200/70 bg-zinc-50/40 text-sm">
                  {!pcDetail.peripherals.length ? (
                    <li className="px-3 py-4 text-slate-500">Нет данных</li>
                  ) : (
                    pcDetail.peripherals.map((p, i) => (
                      <li key={`${p.kind}-${p.name}-${i}`} className="border-b border-zinc-100/80 px-3 py-2.5 last:border-0">
                        <span className="mr-2 inline-block rounded bg-zinc-100 px-1.5 py-0.5 text-xs font-medium text-neutral-900">
                          {PERIPHERAL_KIND_RU[p.kind] ?? p.kind}
                        </span>
                        <span className="text-slate-900">{p.name}</span>
                      </li>
                    ))
                  )}
                </ul>
              </section>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
