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
import {
  api,
  type Computer,
  type Diagram,
  type FloorIconKind,
  type FloorIconMarker,
  type FloorLayout,
  type NetworkPrinter,
  type PcHoverCardField,
} from '../api'
import { useAuth } from '../AuthContext'
import { useDiagramLive, type DiagramLiveIconDrag } from '../useDiagramLive'
import {
  MAX_PLACE_PHOTOS,
  compressImageFileToJpegDataUrl,
  firstPlacePhotoDataUrl,
  parsePlacePhotosJson,
  serializePlacePhotos,
} from '../floorPlacePhotos'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { PrinterDetailModal } from '../components/PrinterDetailModal'
import { useComputerPingLive } from '../hooks/useComputerPingLive'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

import { EquipmentGlyph, EquipmentMenuIcon } from './knowledge-sitemap/FloorIcons'
import { FloorPcMarkerPicker } from './knowledge-sitemap/FloorPcMarkerPicker'
import {
  DEFAULT_LAYOUT,
  DEFAULT_OUTLET_VIS,
  DEFAULT_VIEWBOX,
  EQUIPMENT_KINDS,
  KIND_LABEL_KEY,
  LS_KEY_LAST_FLOOR_ID,
  blobToDataUrl,
  clampCameraZoomToFloorExtent,
  clearPcOutletField,
  clientToSvgPoint,
  floorLayoutLiveFingerprint,
  isOutletKind,
  linkedPcDisplay,
  loadOutletVisibility,
  markerCircleFill,
  markerCircleRadius,
  markerMetaAfterKindChange,
  markerTitle,
  normalizeLayout,
  normalizedPcHoverFields,
  outletCableKind,
  outletNumber,
  parseViewBox,
  pcHoverFieldOptionsInOrder,
  printerDisplayName,
  printerLowestTonerPercent,
  saveOutletVisibility,
  splitLabelLines,
  syncOutletNumberToPc,
  viewBoxesCloseEnough,
  type OutletVisibility,
  type ViewBox,
} from './knowledge-sitemap/floorTools'

export function KnowledgeSitemapPage() {
  const t = useT()
  const toast = useToast()
  const { ask, dialog: confirmDialog } = useConfirmDialog()
  const { locale } = useLocale()
  const { user } = useAuth()
  const canEdit = !!user && (user.is_superuser || user.role === 'editor')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const floorMenuRef = useRef<HTMLDivElement | null>(null)
  const displayMenuRef = useRef<HTMLDivElement | null>(null)
  const autosaveTimerRef = useRef<number | null>(null)
  const autosaveInFlightRef = useRef(false)
  const pendingIconsRef = useRef<FloorIconMarker[] | null>(null)
  const loadedRef = useRef(false)
  const [diagrams, setDiagrams] = useState<Diagram[]>([])
  const [pcDirectory, setPcDirectory] = useState<Computer[]>([])
  const [printerDirectory, setPrinterDirectory] = useState<NetworkPrinter[]>([])
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
  const [sitemapToolsUnlocked, setSitemapToolsUnlocked] = useState(() => {
    try {
      return window.localStorage.getItem('inventory.sitemap.tools_unlocked') === '1'
    } catch {
      return false
    }
  })
  const showSitemapTools = loading || sitemapToolsUnlocked || diagrams.length > 0
  const [saving, setSaving] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [floorMenuOpen, setFloorMenuOpen] = useState(false)
  const [displayMenuOpen, setDisplayMenuOpen] = useState(false)
  const [renamingFloor, setRenamingFloor] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [showLabels, setShowLabels] = useState(true)
  const [showHoverCard, setShowHoverCard] = useState(true)
  const [exportWithLabels, setExportWithLabels] = useState(true)
  const [outletVis, setOutletVis] = useState<OutletVisibility>(DEFAULT_OUTLET_VIS)
  const [pcLinkDialogOpen, setPcLinkDialogOpen] = useState(false)
  const [pcLinkQuery, setPcLinkQuery] = useState('')
  const [printerLinkDialogOpen, setPrinterLinkDialogOpen] = useState(false)
  const [printerLinkQuery, setPrinterLinkQuery] = useState('')
  const [printerDetail, setPrinterDetail] = useState<NetworkPrinter | null>(null)
  const [detailComputerId, setDetailComputerId] = useState<number | null>(null)
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
  const pcHoverFields = useMemo(() => normalizedPcHoverFields(layout), [layout])
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
  const hoveredLinkedPrinter = useMemo(() => {
    if (hoveredMarker?.kind !== 'printer') return null
    const printerId = hoveredMarker.meta?.printer_id
    if (!printerId) return null
    return printerDirectory.find((p) => String(p.id) === String(printerId)) ?? null
  }, [hoveredMarker, printerDirectory])
  const pingByComputerId = useMemo(() => {
    const m = new Map<string, string>()
    for (const pc of pcDirectory) {
      const st = (pc.ping_status || '').toLowerCase()
      if (st) m.set(String(pc.id), st)
    }
    return m
  }, [pcDirectory])
  const pollByPrinterId = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of printerDirectory) {
      const st = (p.poll_status || '').toLowerCase()
      if (st) m.set(String(p.id), st)
    }
    return m
  }, [printerDirectory])
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
  const filteredPrinterDirectory = useMemo(() => {
    const q = printerLinkQuery.trim().toLowerCase()
    if (!q) return printerDirectory
    return printerDirectory.filter((p) => {
      const name = (p.name || '').toLowerCase()
      const model = (p.snmp_model || '').toLowerCase()
      const ip = (p.ip_address || '').toLowerCase()
      const loc = (p.location || '').toLowerCase()
      return name.includes(q) || model.includes(q) || ip.includes(q) || loc.includes(q)
    })
  }, [printerDirectory, printerLinkQuery])
  const selectedLinkedPc = useMemo(() => {
    if (selectedMarker?.kind !== 'pc') return null
    const linkedId = selectedMarker.meta?.computer_id
    if (!linkedId) return null
    return pcDirectory.find((pc) => String(pc.id) === String(linkedId)) ?? null
  }, [pcDirectory, selectedMarker])
  const selectedPcDisplay = useMemo(
    () => (selectedMarker ? linkedPcDisplay(selectedMarker, selectedLinkedPc) : null),
    [selectedLinkedPc, selectedMarker],
  )
  const selectedLinkedPrinter = useMemo(() => {
    if (selectedMarker?.kind !== 'printer') return null
    const linkedId = selectedMarker.meta?.printer_id
    if (!linkedId) return null
    return printerDirectory.find((p) => String(p.id) === String(linkedId)) ?? null
  }, [printerDirectory, selectedMarker])

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
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить карту сайта')
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

  const refreshPcDirectory = useCallback(async () => {
    try {
      const rows = await api.computers({ view: 'map', limit: 5000 })
      setPcDirectory(rows.items as Computer[])
    } catch {
      // Keep the last successful inventory snapshot while the API is unavailable.
    }
  }, [])

  useEffect(() => {
    void refreshPcDirectory()
    const refreshOnFocus = () => void refreshPcDirectory()
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') refreshOnFocus()
    }
    const refreshEveryMinute = window.setInterval(refreshOnFocus, 60_000)
    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisible)
    return () => {
      window.clearInterval(refreshEveryMinute)
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisible)
    }
  }, [refreshPcDirectory])

  useEffect(() => {
    void (async () => {
      try {
        const rows = await api.printers({ limit: 5000, view: 'map' })
        setPrinterDirectory(rows)
      } catch {
        setPrinterDirectory([])
      }
    })()
  }, [])

  // Live online lamps on PC markers (same cache + auto sweep as Computers list).
  useComputerPingLive({
    pollMs: 2500,
    onItems: useCallback((items) => {
      setPcDirectory((prev) => {
        if (!prev.length) return prev
        const map = new Map(items.map((row) => [row.id, row]))
        return prev.map((pc) => {
          const hit = map.get(pc.id)
          if (!hit) return pc
          const nextStatus = (hit.ping_status || '').toLowerCase() || null
          const prevStatus = (pc.ping_status || '').toLowerCase() || null
          const status =
            nextStatus === 'online' || nextStatus === 'offline'
              ? nextStatus
              : prevStatus === 'online' || prevStatus === 'offline'
                ? prevStatus
                : nextStatus
          return {
            ...pc,
            ping_status: status,
            last_ping_at: hit.last_ping_at ?? pc.last_ping_at,
            ip_address: hit.ip_address ?? pc.ip_address,
          }
        })
      })
    }, []),
  })

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
    if (!displayMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      const root = displayMenuRef.current
      if (!root) return
      if (!root.contains(e.target as Node)) setDisplayMenuOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDisplayMenuOpen(false)
    }
    window.addEventListener('mousedown', onDocClick)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('mousedown', onDocClick)
      window.removeEventListener('keydown', onEsc)
    }
  }, [displayMenuOpen])

  useEffect(() => {
    setDetailComputerId(null)
  }, [selectedMarker?.id, selectedMarker?.meta?.computer_id])

  useEffect(() => {
    setPcLinkQuery('')
    setPcLinkDialogOpen(false)
    setPrinterLinkQuery('')
    setPrinterLinkDialogOpen(false)
  }, [selectedMarker?.id])

  useEffect(() => {
    setPrinterDetail(null)
  }, [selectedMarker?.id, selectedMarker?.meta?.printer_id])

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
      icons: (current.icons ?? []).map((m) => {
        if (m.id !== id) return m
        const next = { ...m, ...patch }
        if (patch.kind && patch.kind !== m.kind) {
          next.meta = { ...markerMetaAfterKindChange(m, patch.kind), ...(patch.meta ?? {}) }
        }
        return next
      }),
    }))
  }

  const updateOutletMarker = (
    id: string,
    patch: Partial<FloorIconMarker>,
    opts?: { prevConnectedPcId?: string; prevKind?: FloorIconKind },
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
      const prevKind = opts?.prevKind
      const prevPc = (opts?.prevConnectedPcId ?? '').trim()
      const nextPc = outlet && isOutletKind(outlet.kind) ? (outlet.meta?.connected_pc_id ?? '').trim() : ''
      if (prevPc && prevPc !== nextPc && prevKind && isOutletKind(prevKind)) {
        icons = clearPcOutletField(icons, prevPc, prevKind)
      } else if (outlet && isOutletKind(outlet.kind) && prevPc && prevPc !== nextPc) {
        icons = clearPcOutletField(icons, prevPc, outlet.kind)
      }
      if (outlet && isOutletKind(outlet.kind)) {
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
        toast.error(
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
        toast.error('Достигнут лимит фото для этого объекта.')
        return
      }

      if (opts?.scrollSection) {
        window.requestAnimationFrame(() => {
          placePhotosSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        })
      }

      setPlacePhotoBusy(true)
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
        toast.error(ex instanceof Error ? ex.message : 'Не удалось добавить фото')
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
    const kindLabel = t(KIND_LABEL_KEY[kind])
    const marker: FloorIconMarker = {
      id,
      kind,
      x: cameraView.x + cameraView.w / 2,
      y: cameraView.y + cameraView.h / 2,
      label: kindLabel,
      scale: kind === 'text' ? 1 : isOutletKind(kind) ? 0.67 : 1.1,
      meta: isOutletKind(kind)
        ? { title: kindLabel, outlet_number: '', connected_pc_id: '' }
        : { title: kindLabel, ip: '', mac: '', notes: '' },
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
      try {
        await api.saveDiagramLayout(id, normalizeLayout(nextLayout))
        setLastSavedAt(Date.now())
        lastLocalCommitAtRef.current = Date.now()
        setSaveState('saved')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось сохранить карту')
        setSaveState('error')
      } finally {
        setSaving(false)
      }
    },
    [],
  )

  const updatePcHoverFields = useCallback(
    (fields: PcHoverCardField[]) => {
      if (!canEdit || !activeId) return
      const nextLayout: FloorLayout = {
        ...layout,
        settings: { ...layout.settings, pc_hover_card: { fields } },
      }
      setLayout(nextLayout)
      void saveLayout(activeId, nextLayout)
    },
    [activeId, canEdit, layout, saveLayout],
  )

  const flushIconsPatch = useCallback(async () => {
    if (!activeId || autosaveInFlightRef.current) return
    const icons = pendingIconsRef.current
    if (!icons) return
    pendingIconsRef.current = null
    autosaveInFlightRef.current = true
    setSaveState('saving')
    try {
      await api.patchDiagramLayout(activeId, { icons })
      setLastSavedAt(Date.now())
      lastLocalCommitAtRef.current = Date.now()
      setSaveState('saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось автосохранить изменения')
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
    try {
      const title = window.prompt('Название этажа', `Этаж ${diagrams.length + 1}`)?.trim()
      if (title === undefined) return
      const created = await api.createBlankFloor({ title: title || `Этаж ${diagrams.length + 1}` })
      const rows = await api.diagrams()
      setDiagrams(rows)
      setActiveId(created.id)
      await loadDiagram(created.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить этаж')
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
      toast.error(e instanceof Error ? e.message : 'Не удалось переименовать этаж')
    }
  }

  const deleteFloor = async () => {
    if (!canEdit) return
    setFloorMenuOpen(false)
    if (!activeDiagram) return
    if (diagrams.length <= 1) {
      toast.error('Нельзя удалить единственный этаж')
      return
    }
    if (
      !(await ask({
        title: t('common.delete'),
        body: t('sitemap.deleteFloorConfirm', { title: activeDiagram.title }),
        confirmLabel: t('common.delete'),
        tone: 'danger',
      }))
    )
      return
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
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить этаж')
    }
  }

  const importPng = async (file: File | undefined) => {
    if (!canEdit) return
    if (!file) return
    if (!activeId) {
      toast.error('Сначала выберите этаж для импорта фона')
      if (fileInputRef.current) fileInputRef.current.value = ''
      return
    }
    const hasObjects =
      (layout.icons?.length ?? 0) > 0 ||
      (layout.rooms?.length ?? 0) > 0 ||
      (layout.walls?.length ?? 0) > 0 ||
      (layout.computers?.length ?? 0) > 0
    if (hasObjects) {
      const ok = await ask({
        title: t('sitemap.importPng'),
        body: t('sitemap.replaceBackgroundConfirm'),
        confirmLabel: t('common.confirm'),
      })
      if (!ok) {
        if (fileInputRef.current) fileInputRef.current.value = ''
        return
      }
    }
    setLoading(true)
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
      toast.error(e instanceof Error ? e.message : 'Не удалось импортировать PNG')
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
          toast.error('Не удалось сформировать PNG')
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
      toast.error(e instanceof Error ? e.message : 'Не удалось экспортировать PNG')
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
      <h1 className="sr-only">{t('titles.sitemap')}</h1>
      {!canEdit ? (
        <div className="app-alert app-alert-warning mb-4">{t('sitemap.viewOnly')}</div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-sm">
            <span className="pl-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
              {t('sitemap.floors')}
            </span>
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
          {showSitemapTools ? (
          <>
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
              {t('sitemap.floorSettings')}
            </button>
            {floorMenuOpen ? (
              <div className="popup-enter absolute left-0 top-11 z-20 min-w-64 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-xl">
                <button
                  type="button"
                  className="w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                  onClick={() => void createFloor()}
                  disabled={!canEdit || loading || saving}
                >
                  {t('sitemap.addFloor')}
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
                  {t('sitemap.renameFloor')}
                </button>
                {renamingFloor ? (
                  <form
                    className="mt-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void renameFloor()
                    }}
                  >
                    <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                      {t('sitemap.newFloorName')}
                    </label>
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
                        {t('common.cancel')}
                      </button>
                      <button
                        type="submit"
                        className="app-btn app-btn-primary !min-h-0 !px-2.5 !py-1.5 !text-xs"
                        disabled={!renameValue.trim()}
                      >
                        {t('common.save')}
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
                  {t('sitemap.deleteFloor')}
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
            title={t('sitemap.importPngTitle')}
          >
            {t('sitemap.importPng')}
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary !h-10"
            onClick={() => void exportPng()}
            disabled={!activeId || saving}
            title={t('sitemap.exportPngTitle')}
          >
            {t('sitemap.exportPng')}
          </button>
          </>
          ) : (
            <button
              type="button"
              className="app-btn app-btn-secondary !h-10"
              onClick={() => {
                setSitemapToolsUnlocked(true)
                try {
                  window.localStorage.setItem('inventory.sitemap.tools_unlocked', '1')
                } catch {
                  /* ignore */
                }
              }}
              title={t('sitemap.showAllToolsTitle')}
            >
              {t('sitemap.showAllTools')}
            </button>
          )}
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
                onClick={() => {
                  setToolboxOpen((v) => !v)
                  setDisplayMenuOpen(false)
                }}
                disabled={!canEdit}
                title={t('sitemap.objectsTitle')}
              >
                {t('sitemap.objects')}
              </button>
              {toolboxOpen ? (
                <div className="popup-enter absolute left-0 top-11 z-20 grid min-w-64 grid-cols-2 gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-xl">
                  {EQUIPMENT_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-left text-xs font-medium text-[var(--color-fg)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                      onClick={() => {
                        addMarker(kind)
                      }}
                      disabled={!canEdit}
                    >
                      <EquipmentMenuIcon kind={kind} />
                      {t(KIND_LABEL_KEY[kind])}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="relative" ref={displayMenuRef}>
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm font-medium text-[var(--color-fg-muted)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
                onClick={() => {
                  setDisplayMenuOpen((v) => !v)
                  setToolboxOpen(false)
                }}
                aria-expanded={displayMenuOpen}
                aria-haspopup="menu"
              >
                {t('sitemap.display')}
              </button>
              {displayMenuOpen ? (
                <div className="popup-enter absolute left-0 top-11 z-20 min-w-56 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5 shadow-xl">
                  {(
                    [
                      {
                        key: 'hideLabels',
                        checked: !showLabels,
                        onChange: (checked: boolean) => setShowLabels(!checked),
                        label: t('sitemap.hideLabels'),
                      },
                      {
                        key: 'hoverCard',
                        checked: showHoverCard,
                        onChange: (checked: boolean) => setShowHoverCard(checked),
                        label: t('sitemap.hoverCard'),
                      },
                      {
                        key: 'ethOutlets',
                        checked: outletVis.ethOutlets,
                        onChange: (checked: boolean) => setOutletVisibility({ ethOutlets: checked }),
                        label: t('sitemap.ethOutlets'),
                      },
                      {
                        key: 'phoneOutlets',
                        checked: outletVis.phoneOutlets,
                        onChange: (checked: boolean) => setOutletVisibility({ phoneOutlets: checked }),
                        label: t('sitemap.phoneOutlets'),
                      },
                      {
                        key: 'ethCables',
                        checked: outletVis.ethCables,
                        onChange: (checked: boolean) => setOutletVisibility({ ethCables: checked }),
                        label: t('sitemap.ethCables'),
                      },
                      {
                        key: 'phoneCables',
                        checked: outletVis.phoneCables,
                        onChange: (checked: boolean) => setOutletVisibility({ phoneCables: checked }),
                        label: t('sitemap.phoneCables'),
                      },
                      {
                        key: 'exportWithLabels',
                        checked: exportWithLabels,
                        onChange: (checked: boolean) => setExportWithLabels(checked),
                        label: t('sitemap.exportWithLabels'),
                      },
                    ] as const
                  ).map((row) => (
                    <label
                      key={row.key}
                      className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                    >
                      <input
                        type="checkbox"
                        checked={row.checked}
                        onChange={(e) => row.onChange(e.target.checked)}
                      />
                      {row.label}
                    </label>
                  ))}
                  {canEdit ? (
                    <div className="mt-1 border-t border-[var(--color-border)] px-2.5 pb-2 pt-2">
                      <div className="text-xs font-semibold text-[var(--color-fg)]">Поля карточки ПК</div>
                      <div className="mt-0.5 text-[11px] leading-snug text-[var(--color-fg-muted)]">
                        Общая настройка для этой карты. Стрелками задайте порядок.
                      </div>
                      <div className="mt-2 max-h-64 space-y-1 overflow-y-auto pr-0.5">
                        {pcHoverFieldOptionsInOrder(pcHoverFields).map((field) => {
                          const index = pcHoverFields.indexOf(field.id)
                          const enabled = index >= 0
                          return (
                            <div
                              key={field.id}
                              className="flex items-center gap-1 rounded-lg px-1 py-1 text-xs text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                            >
                              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={enabled}
                                  onChange={(e) => {
                                    updatePcHoverFields(
                                      e.target.checked
                                        ? [...pcHoverFields, field.id]
                                        : pcHoverFields.filter((id) => id !== field.id),
                                    )
                                  }}
                                />
                                <span className="truncate">{field.label}</span>
                              </label>
                              <button
                                type="button"
                                className="h-5 w-5 rounded border border-[var(--color-border)] text-xs leading-none disabled:cursor-not-allowed disabled:opacity-35"
                                onClick={() => {
                                  if (index <= 0) return
                                  const next = [...pcHoverFields]
                                  ;[next[index - 1], next[index]] = [next[index], next[index - 1]]
                                  updatePcHoverFields(next)
                                }}
                                disabled={!enabled || index === 0}
                                title="Выше"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="h-5 w-5 rounded border border-[var(--color-border)] text-xs leading-none disabled:cursor-not-allowed disabled:opacity-35"
                                onClick={() => {
                                  if (index < 0 || index === pcHoverFields.length - 1) return
                                  const next = [...pcHoverFields]
                                  ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
                                  updatePcHoverFields(next)
                                }}
                                disabled={!enabled || index === pcHoverFields.length - 1}
                                title="Ниже"
                              >
                                ↓
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            {user && activeId ? (
              <div
                className="inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-fg-muted)] shadow-sm"
                title={t('sitemap.peersTitle')}
              >
                <span
                  className="inline-flex shrink-0 items-center"
                  title={liveConnected ? t('sitemap.liveConnected') : t('sitemap.liveDisconnected')}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full motion-safe:transition-opacity motion-safe:duration-500 ${
                      liveConnected ? 'bg-emerald-500 motion-safe:animate-pulse' : 'bg-[var(--color-border-strong)]'
                    }`}
                    aria-hidden
                  />
                </span>
                <span className="font-medium text-[var(--color-fg)]">{t('sitemap.online')}</span>
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
              title={t('sitemap.autosaveTitle')}
            >
              {t('sitemap.autosave', {
                time: lastSavedAt
                  ? new Date(lastSavedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : '—',
              })}
            </div>
          </div>

          <div className="relative h-[min(72vh,820px)] min-h-[520px] bg-[var(--color-surface-muted)]">
            <div className="pointer-events-none absolute bottom-2 right-2 z-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] text-[var(--color-fg-muted)] shadow-sm">
              {t('sitemap.mapHint')}
            </div>
            {loading || !activeDiagram ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
                {t('sitemap.loadingMap')}
              </div>
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
                  const linkedParkId =
                    marker.kind === 'pc' ? String(marker.meta?.computer_id || '').trim() : ''
                  const pingSt = linkedParkId ? pingByComputerId.get(linkedParkId) : undefined
                  const showOnlineLamp = pingSt === 'online'
                  const linkedPrinterId =
                    marker.kind === 'printer' ? String(marker.meta?.printer_id || '').trim() : ''
                  const printerPollSt = linkedPrinterId ? pollByPrinterId.get(linkedPrinterId) : undefined
                  const showPrinterOnlineLamp = printerPollSt === 'online'
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
                      onDoubleClick={(e) => {
                        if (marker.kind === 'printer') {
                          e.stopPropagation()
                          const pid = String(marker.meta?.printer_id || '').trim()
                          if (!pid) return
                          const row = printerDirectory.find((p) => String(p.id) === pid)
                          if (row) setPrinterDetail(row)
                          return
                        }
                        if (marker.kind === 'pc') {
                          e.stopPropagation()
                          const cid = Number(marker.meta?.computer_id)
                          if (!Number.isFinite(cid) || cid <= 0) return
                          setDetailComputerId(cid)
                        }
                      }}
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
                      {showOnlineLamp ? (
                        <g transform="translate(-20 -20)" pointerEvents="none">
                          <title>{t('sitemap.pcOnline')}</title>
                          <circle r="8.5" fill="rgba(16,185,129,0.3)" />
                          <circle r="5.5" fill="#10b981" stroke="white" strokeWidth="1.6" />
                        </g>
                      ) : null}
                      {showPrinterOnlineLamp ? (
                        <g transform="translate(-20 -20)" pointerEvents="none">
                          <title>{t('sitemap.pcOnline')}</title>
                          <circle r="8.5" fill="rgba(16,185,129,0.3)" />
                          <circle r="5.5" fill="#10b981" stroke="white" strokeWidth="1.6" />
                        </g>
                      ) : null}
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
                    const pc = linkedPcDisplay(hoveredMarker, hoveredLinkedPc)
                    const ping = (hoveredLinkedPc?.ping_status || '').toLowerCase()
                    const netLabel =
                      ping === 'online'
                        ? t('sitemap.pcOnline')
                        : ping === 'offline'
                          ? t('sitemap.pcOffline')
                          : hoveredLinkedPc
                            ? t('sitemap.pcUnknown')
                            : '—'
                    const lines = pcHoverFields.map((field) => {
                      switch (field) {
                        case 'title':
                          return { field, text: markerTitle(hoveredMarker) }
                        case 'hostname':
                          return { field, text: `ПК: ${pc.hostname}` }
                        case 'employee_extension':
                          return { field, text: `Внутр. номер: ${hoveredMarker.meta?.employee_extension || '—'}` }
                        case 'outlets':
                          return { field, text: `Розетки: Eth ${eth} · тел. ${phone}` }
                        case 'ip':
                          return { field, text: `IP: ${pc.ip}` }
                        case 'mac':
                          return { field, text: `MAC: ${pc.mac}` }
                        case 'os':
                          return { field, text: `ОС: ${pc.os}` }
                        case 'cpu':
                          return { field, text: `CPU: ${pc.cpu}` }
                        case 'ram':
                          return { field, text: `RAM: ${pc.ramGb != null ? `${pc.ramGb} GB` : '—'}` }
                        case 'manufacturer':
                          return { field, text: `Производитель: ${pc.manufacturer}` }
                        case 'model':
                          return { field, text: `Модель: ${pc.model}` }
                        case 'serial_number':
                          return { field, text: `S/N: ${pc.serialNumber}` }
                        case 'tags':
                          return { field, text: `Теги: ${pc.tags.map((tag) => tag.name).join(', ') || '—'}` }
                        case 'ping_status':
                          return { field, text: `● ${netLabel}` }
                      }
                    })
                    if (!lines.length) return null
                    const boxH = 16 + lines.length * 20
                    return (
                      <g transform={hoverTransform} pointerEvents="none">
                        <rect width="256" height={boxH} rx="12" fill="rgba(15,23,42,0.92)" />
                        {lines.map((line, index) => (
                          <text
                            key={line.field}
                            x="14"
                            y={24 + index * 20}
                            fill={
                              line.field === 'ping_status'
                                ? ping === 'online'
                                  ? '#34d399'
                                  : ping === 'offline'
                                    ? '#fda4af'
                                    : 'rgba(255,255,255,0.65)'
                                : line.field === 'title'
                                  ? 'white'
                                  : 'rgba(255,255,255,0.78)'
                            }
                            fontSize={line.field === 'title' ? 14 : 12}
                            fontWeight={line.field === 'title' || line.field === 'ping_status' ? 700 : 400}
                            fontFamily={textFamily}
                          >
                            {line.text}
                          </text>
                        ))}
                      </g>
                    )
                  }

                  if (hoveredMarker.kind === 'printer') {
                    const linked = hoveredLinkedPrinter
                    const ip =
                      (hoveredMarker.meta?.ip ?? '').trim() ||
                      linked?.ip_address?.trim() ||
                      '—'
                    const model =
                      (hoveredMarker.meta?.model ?? '').trim() ||
                      (linked ? printerDisplayName(linked) : '') ||
                      '—'
                    const pages =
                      linked?.page_count != null
                        ? t('sitemap.printerPages', { count: String(linked.page_count) })
                        : null
                    const tonerPct = linked ? printerLowestTonerPercent(linked) : null
                    const toner =
                      tonerPct != null ? t('sitemap.printerToner', { pct: String(tonerPct) }) : null
                    const poll = (linked?.poll_status || '').toLowerCase()
                    const netLabel =
                      poll === 'online'
                        ? t('sitemap.pcOnline')
                        : poll === 'offline'
                          ? t('sitemap.pcOffline')
                          : linked
                            ? t('sitemap.pcUnknown')
                            : null
                    const lines = [model, `IP: ${ip}`, pages, toner, netLabel ? `● ${netLabel}` : null].filter(
                      Boolean,
                    ) as string[]
                    const boxH = 28 + lines.length * 18
                    return (
                      <g transform={hoverTransform} pointerEvents="none">
                        <rect width="256" height={boxH} rx="12" fill="rgba(15,23,42,0.92)" />
                        <text x="14" y="24" fill="white" fontSize="14" fontWeight="700" fontFamily={textFamily}>
                          {markerTitle(hoveredMarker)}
                        </text>
                        {lines.map((line, idx) => {
                          const isNet = Boolean(netLabel) && idx === lines.length - 1 && line.startsWith('●')
                          return (
                            <text
                              key={`printer-hover-${idx}`}
                              x="14"
                              y={46 + idx * 18}
                              fill={
                                isNet
                                  ? poll === 'online'
                                    ? '#34d399'
                                    : poll === 'offline'
                                      ? '#fda4af'
                                      : 'rgba(255,255,255,0.65)'
                                  : idx === 0
                                    ? 'rgba(255,255,255,0.78)'
                                    : 'rgba(255,255,255,0.72)'
                              }
                              fontSize={idx === 1 ? 11 : 12}
                              fontWeight={isNet ? 600 : 400}
                              fontFamily={textFamily}
                            >
                              {line}
                            </text>
                          )
                        })}
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
                          {t(KIND_LABEL_KEY[hoveredMarker.kind])}
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
                  const pc = linkedPcDisplay(hoveredMarker, hoveredLinkedPc)
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
                        OS: {pc.os}
                      </text>
                      <text x="14" y={tIp} fill="rgba(255,255,255,0.62)" fontSize="11" fontFamily={textFamily}>
                        IP: {pc.ip} · MAC: {pc.mac}
                      </text>
                      {hoveredLinkedPc ? (
                        <text x="14" y={tRam} fill="rgba(255,255,255,0.80)" fontSize="11" fontFamily={textFamily}>
                          {`RAM: ${pc.ramGb != null ? `${pc.ramGb} GB` : '—'}`}
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
              <div className="text-sm font-semibold text-[var(--color-fg)]">{t('sitemap.properties')}</div>
              <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                {selectedIds.length > 1
                  ? t('sitemap.selectedCount', { count: selectedIds.length })
                  : selectedMarker
                    ? markerTitle(selectedMarker, t(KIND_LABEL_KEY[selectedMarker.kind]))
                    : t('sitemap.noneSelected')}
              </div>
            </div>
          </div>
          {!selectedMarker ? (
            <div className="mt-3 space-y-3">
              <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-4 text-sm text-[var(--color-fg-muted)]">
                {selectedIds.length > 1 ? t('sitemap.hintMulti') : t('sitemap.hintEmpty')}
              </div>
              <ol className="space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-3 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">1.</span> {t('sitemap.tip1')}
                </li>
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">2.</span> {t('sitemap.tip2')}
                </li>
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">3.</span> {t('sitemap.tip3')}
                </li>
                <li>
                  <span className="font-semibold text-[var(--color-fg)]">4.</span> {t('sitemap.tip4')}
                </li>
              </ol>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <label className="block">
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
                  {t('sitemap.type')}
                </span>
                <select
                  value={selectedMarker.kind}
                  onChange={(e) => {
                    const kind = e.target.value as FloorIconKind
                    if (kind === selectedMarker.kind) return
                    if (isOutletKind(selectedMarker.kind) || isOutletKind(kind)) {
                      const prevPc = selectedMarker.meta?.connected_pc_id ?? undefined
                      updateOutletMarker(
                        selectedMarker.id,
                        { kind, meta: markerMetaAfterKindChange(selectedMarker, kind) },
                        { prevConnectedPcId: prevPc, prevKind: selectedMarker.kind },
                      )
                      return
                    }
                    updateMarker(selectedMarker.id, { kind })
                  }}
                  className="app-input mt-0.5 !min-h-0 !py-2"
                  disabled={!canEdit}
                >
                  {EQUIPMENT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {t(KIND_LABEL_KEY[kind])}
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
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-2 space-y-2">
                  <label className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
                      Номер розетки
                    </span>
                    <input
                      value={selectedMarker.meta?.outlet_number ?? ''}
                      onChange={(e) =>
                        updateOutletMarker(selectedMarker.id, {
                          meta: { ...selectedMarker.meta, outlet_number: e.target.value },
                        })
                      }
                      className="mt-0.5 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                      placeholder="Например: 12-A"
                      disabled={!canEdit}
                    />
                  </label>
                  <div className="block">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
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
                      <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">Сначала добавьте объект «ПК» на этот этаж.</p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {selectedMarker.kind === 'pc' ? (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
                    {t('sitemap.pcParkLink')}
                  </span>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                      onClick={() => setPcLinkDialogOpen(true)}
                      disabled={!canEdit}
                    >
                      {selectedMarker.meta?.computer_id ? t('sitemap.pcRebind') : t('sitemap.pcBind')}
                    </button>
                    {selectedMarker.meta?.computer_id ? (
                      <button
                        type="button"
                        className="h-8 rounded-lg border border-blue-200 bg-[var(--color-surface)] px-2.5 text-xs font-medium text-blue-700 transition hover:bg-blue-50 disabled:opacity-60"
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
                        {t('sitemap.pcUnbind')}
                      </button>
                    ) : null}
                  </div>
                  {selectedMarker.meta?.computer_id ? (
                    <div className="mt-1.5 space-y-0.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-1.5 text-[11px] leading-snug text-[var(--color-fg)]">
                      <div>ПК: {selectedPcDisplay?.hostname || selectedMarker.meta.computer_id}</div>
                      <div>Внутренний номер: {selectedMarker.meta.employee_extension || '—'}</div>
                      <div>
                        Розетки: Ethernet {selectedMarker.meta.ethernet_outlet || '—'} · тел.{' '}
                        {selectedMarker.meta.phone_outlet || '—'}
                      </div>
                      <div>OS: {selectedPcDisplay?.os || '—'}</div>
                      <div>CPU: {selectedPcDisplay?.cpu || '—'}</div>
                      <div>RAM: {selectedPcDisplay?.ramGb != null ? `${selectedPcDisplay.ramGb} GB` : '—'}</div>
                      <div>
                        HW: {selectedPcDisplay?.manufacturer || '—'} {selectedPcDisplay?.model || ''}
                      </div>
                      <div>Теги: {selectedPcDisplay?.tags.map((t) => t.name).join(', ') || '—'}</div>
                      <button
                        type="button"
                        className="mt-1.5 rounded-md border border-slate-300 bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                        onClick={() => {
                          const pcId = Number(selectedMarker.meta?.computer_id)
                          if (!Number.isFinite(pcId) || pcId <= 0) return
                          setDetailComputerId(pcId)
                        }}
                      >
                        {t('sitemap.pcLearnMore')}
                      </button>
                    </div>
                  ) : null}
                </label>
              ) : null}

              {selectedMarker.kind === 'printer' ? (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
                    {t('sitemap.printerLink')}
                  </span>
                  <div className="mt-0.5 flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      className="h-8 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                      onClick={() => setPrinterLinkDialogOpen(true)}
                      disabled={!canEdit}
                    >
                      {selectedMarker.meta?.printer_id ? t('sitemap.printerRebind') : t('sitemap.printerBind')}
                    </button>
                    {selectedMarker.meta?.printer_id ? (
                      <button
                        type="button"
                        className="h-8 rounded-lg border border-amber-200 bg-[var(--color-surface)] px-2.5 text-xs font-medium text-amber-800 transition hover:bg-amber-50 disabled:opacity-60"
                        onClick={() =>
                          updateMarker(selectedMarker.id, {
                            meta: {
                              ...selectedMarker.meta,
                              printer_id: '',
                              model: '',
                              ip: '',
                            },
                          })
                        }
                        disabled={!canEdit}
                      >
                        {t('sitemap.printerUnbind')}
                      </button>
                    ) : null}
                  </div>
                  {selectedMarker.meta?.printer_id ? (
                    <div className="mt-1.5 space-y-0.5 rounded-lg border border-amber-100 bg-amber-50/50 px-2.5 py-1.5 text-[11px] leading-snug text-[var(--color-fg)]">
                      <div>
                        {selectedLinkedPrinter
                          ? printerDisplayName(selectedLinkedPrinter)
                          : selectedMarker.meta.printer_id}
                      </div>
                      <div>
                        IP:{' '}
                        {selectedLinkedPrinter?.ip_address || selectedMarker.meta.ip || '—'}
                      </div>
                      <div>
                        {selectedLinkedPrinter?.page_count != null
                          ? t('sitemap.printerPages', { count: String(selectedLinkedPrinter.page_count) })
                          : t('sitemap.printerPages', { count: '—' })}
                      </div>
                      {(() => {
                        const pct = selectedLinkedPrinter
                          ? printerLowestTonerPercent(selectedLinkedPrinter)
                          : null
                        return pct != null ? (
                          <div>{t('sitemap.printerToner', { pct: String(pct) })}</div>
                        ) : null
                      })()}
                      <div>
                        {(selectedLinkedPrinter?.poll_status || '').toLowerCase() === 'online'
                          ? t('sitemap.pcOnline')
                          : (selectedLinkedPrinter?.poll_status || '').toLowerCase() === 'offline'
                            ? t('sitemap.pcOffline')
                            : t('sitemap.pcUnknown')}
                      </div>
                      <button
                        type="button"
                        className="mt-1.5 rounded-md border border-slate-300 bg-[var(--color-surface)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                        onClick={() => {
                          if (selectedLinkedPrinter) {
                            setPrinterDetail(selectedLinkedPrinter)
                            return
                          }
                          const id = Number(selectedMarker.meta?.printer_id)
                          if (!Number.isFinite(id) || id <= 0) return
                          void api
                            .printers({ limit: 5000, view: 'map' })
                            .then((rows) => {
                              setPrinterDirectory(rows)
                              const hit = rows.find((p) => p.id === id) ?? null
                              setPrinterDetail(hit)
                            })
                            .catch(() => setPrinterDetail(null))
                        }}
                      >
                        {t('sitemap.printerLearnMore')}
                      </button>
                    </div>
                  ) : null}
                </label>
              ) : null}

              {selectedMarker.kind === 'pc' ? (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
                    Внутренний номер сотрудника
                  </span>
                  <input
                    value={selectedMarker.meta?.employee_extension ?? ''}
                    onChange={(e) =>
                      updateMarker(selectedMarker.id, {
                        meta: { ...selectedMarker.meta, employee_extension: e.target.value },
                      })
                    }
                    className="mt-0.5 h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                    placeholder="Например: 2431"
                    disabled={!canEdit}
                  />
                </label>
              ) : null}

              {selectedMarker.kind === 'pc' ? (
                <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2.5 py-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Розетки</div>
                  <div className="mt-1.5 grid min-w-0 grid-cols-2 gap-1.5">
                    <label className="block min-w-0">
                      <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">Ethernet</span>
                      <input
                        value={selectedMarker.meta?.ethernet_outlet ?? ''}
                        onChange={(e) =>
                          updateMarker(selectedMarker.id, {
                            meta: { ...selectedMarker.meta, ethernet_outlet: e.target.value },
                          })
                        }
                        className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                        placeholder="Напр. 12-A"
                        disabled={!canEdit}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">Телефон</span>
                      <input
                        value={selectedMarker.meta?.phone_outlet ?? ''}
                        onChange={(e) =>
                          updateMarker(selectedMarker.id, {
                            meta: { ...selectedMarker.meta, phone_outlet: e.target.value },
                          })
                        }
                        className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                        placeholder="Напр. 08-B"
                        disabled={!canEdit}
                      />
                    </label>
                  </div>
                </div>
              ) : null}

              <div className="grid grid-cols-3 gap-1.5">
                <label className="block min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">X</span>
                  <input
                    type="number"
                    value={Math.round(selectedMarker.x)}
                    onChange={(e) => updateMarker(selectedMarker.id, { x: Number(e.target.value) || 0 })}
                    className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                    disabled={!canEdit}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Y</span>
                  <input
                    type="number"
                    value={Math.round(selectedMarker.y)}
                    onChange={(e) => updateMarker(selectedMarker.id, { y: Number(e.target.value) || 0 })}
                    className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                    disabled={!canEdit}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Размер</span>
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
                    className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                    disabled={!canEdit}
                  />
                </label>
              </div>

              {!isOutletKind(selectedMarker.kind) ? (
                <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2">
                  <label className="block min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">IP</span>
                    <input
                      value={selectedMarker.meta?.ip ?? ''}
                      onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, ip: e.target.value } })}
                      className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                      placeholder="10.0.0.1"
                      disabled={!canEdit}
                    />
                  </label>
                  <label className="block min-w-0">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">MAC</span>
                    <input
                      value={selectedMarker.meta?.mac ?? ''}
                      onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, mac: e.target.value } })}
                      className="mt-0.5 h-9 w-full min-w-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 font-mono text-[13px] leading-snug tracking-tight text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
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
                    <span className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
                      Фото с места установки
                    </span>
                    <span className="group/tooltip absolute right-0 top-0 inline-flex">
                      <button
                        type="button"
                        className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 bg-[var(--color-surface)] text-[10px] font-bold leading-none text-[var(--color-fg-muted)] outline-none transition hover:border-slate-400 hover:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1"
                        aria-describedby={placePhotosHelpTipId}
                        aria-label={t('sitemap.photoHelpAria')}
                      >
                        i
                      </button>
                      <span
                        id={placePhotosHelpTipId}
                        role="tooltip"
                        className="pointer-events-none absolute right-full top-1/2 z-40 mr-2 w-max max-w-[min(19rem,100%)] -translate-y-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-snug tracking-normal text-[var(--color-fg-muted)] opacity-0 shadow-lg transition-opacity duration-150 group-hover/tooltip:opacity-100 group-focus-within/tooltip:opacity-100"
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
                    className="mt-1.5 h-8 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-xs font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
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
                          className="mt-1 h-7 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] text-[var(--color-fg)] outline-none focus:border-neutral-400"
                          placeholder="Подпись"
                          disabled={!canEdit}
                        />
                        <button
                          type="button"
                          className="mt-1 w-full rounded-md border border-blue-100 bg-[var(--color-surface)] py-0.5 text-[10px] font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50"
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
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Комментарий</span>
                  <textarea
                    value={selectedMarker.meta?.notes ?? ''}
                    onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, notes: e.target.value } })}
                    className="mt-0.5 min-h-[7.5rem] w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                    placeholder="Где смонтировано, как добраться, особенности доступа, ответственный…"
                    disabled={!canEdit}
                  />
                </label>
              </div>
              ) : (
                <label className="block">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">Комментарий</span>
                  <textarea
                    value={selectedMarker.meta?.notes ?? ''}
                    onChange={(e) => updateMarker(selectedMarker.id, { meta: { ...selectedMarker.meta, notes: e.target.value } })}
                    className="mt-0.5 min-h-[4.5rem] w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                    placeholder="Расположение в кабинете, шкаф, патч-панель…"
                    disabled={!canEdit}
                  />
                </label>
              )}

              <button
                type="button"
                className="w-full rounded-lg border border-blue-100 bg-[var(--color-surface)] px-2.5 py-1.5 text-sm font-medium text-blue-600 transition hover:border-blue-200 hover:bg-blue-50"
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
            className="absolute right-4 top-4 rounded-full border border-white/30 bg-[var(--color-surface)]/10 px-3 py-1.5 text-sm font-medium text-white backdrop-blur hover:bg-[var(--color-surface)]/20"
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
          <div className="w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_70px_-24px_rgba(2,6,23,0.5)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-[var(--color-fg)]">Привязка к парку ПК</div>
                <div className="text-xs text-[var(--color-fg-muted)]">Название объекта на карте не изменяется</div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                onClick={() => setPcLinkDialogOpen(false)}
              >
                Закрыть
              </button>
            </div>
            <div className="p-4">
              <input
                value={pcLinkQuery}
                onChange={(e) => setPcLinkQuery(e.target.value)}
                className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                placeholder="Введите начало: hostname / serial / model"
                autoFocus
              />
              <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                {filteredPcDirectory.map((pc) => (
                  <button
                    key={pc.id}
                    type="button"
                    className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-sm text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                    onClick={() => {
                      updateMarker(selectedMarker.id, {
                        meta: {
                          ...selectedMarker.meta,
                          computer_id: String(pc.id),
                          employee_extension: selectedMarker.meta?.employee_extension ?? '',
                        },
                      })
                      setPcLinkDialogOpen(false)
                    }}
                  >
                    <div className="font-semibold">{pc.hostname}</div>
                    <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                      {pc.os_name || 'OS —'} · RAM {pc.ram_gb != null ? `${pc.ram_gb} GB` : '—'} · SN {pc.serial_number || '—'}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">Теги: {pc.tags?.map((t) => t.name).join(', ') || '—'}</div>
                  </button>
                ))}
                {filteredPcDirectory.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-4 text-sm text-[var(--color-fg-muted)]">
                    Ничего не найдено
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {printerLinkDialogOpen && selectedMarker?.kind === 'printer' ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/35 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_24px_70px_-24px_rgba(2,6,23,0.5)]">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-[var(--color-fg)]">{t('sitemap.printerLink')}</div>
                <div className="text-xs text-[var(--color-fg-muted)]">{t('sitemap.printerLinkHint')}</div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                onClick={() => setPrinterLinkDialogOpen(false)}
              >
                Закрыть
              </button>
            </div>
            <div className="p-4">
              <input
                value={printerLinkQuery}
                onChange={(e) => setPrinterLinkQuery(e.target.value)}
                className="h-10 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-fg)] outline-none transition focus:border-neutral-400"
                placeholder={t('sitemap.printerSearchPlaceholder')}
                autoFocus
              />
              <div className="mt-3 max-h-72 space-y-2 overflow-auto pr-1">
                {filteredPrinterDirectory.map((printer) => {
                  const toner = printerLowestTonerPercent(printer)
                  return (
                    <button
                      key={printer.id}
                      type="button"
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-left text-sm text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                      onClick={() => {
                        updateMarker(selectedMarker.id, {
                          meta: {
                            ...selectedMarker.meta,
                            printer_id: String(printer.id),
                            model: printer.snmp_model || printer.name || '',
                            ip: printer.ip_address || '',
                          },
                          label: selectedMarker.label || printerDisplayName(printer),
                        })
                        setPrinterLinkDialogOpen(false)
                      }}
                    >
                      <div className="font-semibold">{printerDisplayName(printer)}</div>
                      <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                        {printer.ip_address || 'IP —'}
                        {printer.page_count != null ? ` · ${printer.page_count} стр.` : ''}
                        {toner != null ? ` · тонер ${toner}%` : ''}
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                        {printer.location || '—'} · {(printer.poll_status || 'unknown').toLowerCase()}
                      </div>
                    </button>
                  )
                })}
                {filteredPrinterDirectory.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-4 text-sm text-[var(--color-fg-muted)]">
                    {t('sitemap.printerNothingFound')}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <PrinterDetailModal
        printer={printerDetail}
        onClose={() => setPrinterDetail(null)}
        onChanged={(row) => {
          setPrinterDetail(row)
          setPrinterDirectory((prev) => {
            const idx = prev.findIndex((p) => p.id === row.id)
            if (idx < 0) return [row, ...prev]
            const next = prev.slice()
            next[idx] = row
            return next
          })
        }}
        overlayZClass="z-[60]"
      />
      <ComputerDetailModal
        computerId={detailComputerId}
        preview={pcDirectory.find((pc) => pc.id === detailComputerId) ?? selectedLinkedPc ?? null}
        onClose={() => setDetailComputerId(null)}
        onChanged={() => {
          void refreshPcDirectory()
        }}
        overlayZClass="z-[60]"
      />
      {confirmDialog}
    </div>
  )
}
