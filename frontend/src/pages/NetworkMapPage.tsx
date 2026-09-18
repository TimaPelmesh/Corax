import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import ReactFlow, {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeTypes,
  type Node,
  type NodeTypes,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodesDelete,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api, type NetworkDevice, type NetworkMapLiveItem, type NetworkMapSceneDto, type NetworkPrinter, type NetworkTopology } from '../api'
import { useAuth } from '../AuthContext'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { NetworkDeviceDetailModal } from '../components/NetworkDeviceDetailModal'
import { PrinterDetailModal } from '../components/PrinterDetailModal'
import { useLocale } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { NetworkMapEquipmentNode, NetworkMapGroupNode, type EquipmentNodeData } from './network-map/NetworkMapCanvasNode'
import { NetworkMapCableEdge } from './network-map/NetworkMapCableEdge'
import { NetworkMapClearDialog } from './network-map/NetworkMapClearDialog'
import { NetworkMapConfirmDialog } from './network-map/NetworkMapConfirmDialog'
import { NetworkMapDock } from './network-map/NetworkMapDock'
import { NetworkMapInspector } from './network-map/NetworkMapInspector'
import { NetworkMapScenesBar } from './network-map/NetworkMapScenesBar'
import { NetworkMapTray } from './network-map/NetworkMapTray'
import {
  applyFrameMembership,
  collectScene,
  decorateFocus,
  decorateSelection,
  equipmentHeight,
  equipmentWidth,
  toFlowEdges,
  toFlowNodes,
  toWorldScene,
  viewportFlowCenter,
} from './network-map/flow'
import { compressMapImage } from './network-map/image'
import { bindsFromScene, deviceTypeForStencil, hydrateScene } from './network-map/mergeScene'
import { applyNeighborCluster, offersFromTopology } from './network-map/neighborsAround'
import { exportNetworkMapPng } from './network-map/exportPng'
import { onMapNodeResized } from './network-map/NetworkMapResizer'
import { cloneScene, gearNotOnMap, ipv4Slash24, matchMapQuery, subnetLayers, type TrayGear } from './network-map/inventory'
import { createUndoStack } from './network-map/undo'
import './network-map/network-map.css'
import {
  MAX_MAP_IMAGES,
  NETWORK_MAP_DND,
  bindKey,
  emptyNetworkMapScene,
  type MapLiveItem,
  type MergedCanvasNode,
  type NetworkMapBind,
  type NetworkMapScene,
  type NetworkMapStencil,
  type PaletteDrag,
} from './network-map/types'

const NODE_TYPES: NodeTypes = { equipment: NetworkMapEquipmentNode, groupFrame: NetworkMapGroupNode }
const EDGE_TYPES: EdgeTypes = { cable: NetworkMapCableEdge }
const RF_PRO = { hideAttribution: true }
const SCENE_STORE_KEY = 'corax-network-map-scene-id'
const TRAY_STORE_KEY = 'corax-network-map-tray-open'

function newId(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`
}

function toLive(items: NetworkMapLiveItem[]): MapLiveItem[] {
  return items.map((item) => ({
    type: item.type as MapLiveItem['type'],
    id: item.id,
    label: item.label,
    ip: item.ip,
    vendor: item.vendor,
    status: item.status,
    missing: item.missing,
    ports: item.ports,
    portCount: item.port_count ?? null,
  }))
}

export function NetworkMapPage() {
  return (
    <ReactFlowProvider>
      <NetworkMapEditor />
    </ReactFlowProvider>
  )
}

function NetworkMapEditor() {
  const { t } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')
  const { screenToFlowPosition, getViewport, setViewport, getNodes, getEdges, fitView, setCenter } = useReactFlow()

  const [loading, setLoading] = useState(true)
  const [scene, setScene] = useState<NetworkMapScene>(emptyNetworkMapScene())
  const [mergedNodes, setMergedNodes] = useState<MergedCanvasNode[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [clearOpen, setClearOpen] = useState(false)
  const [linking, setLinking] = useState(false)
  const [detail, setDetail] = useState<
    | { kind: 'network_device'; id: number }
    | { kind: 'computer'; id: number }
    | { kind: 'printer'; printer: NetworkPrinter }
    | null
  >(null)
  const [saving, setSaving] = useState(false)
  const [sceneId, setSceneId] = useState(0)
  const [sceneTitle, setSceneTitle] = useState('Карта сети')
  const [scenes, setScenes] = useState<Array<{ id: number; title: string; updated_at: string | null; node_count: number; edge_count: number }>>([])
  const [topology, setTopology] = useState<NetworkTopology | null>(null)
  const [neighborsBusy, setNeighborsBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [traceTarget, setTraceTarget] = useState('')
  const [tracing, setTracing] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [trayQuery, setTrayQuery] = useState('')
  const [inventory, setInventory] = useState<NetworkDevice[]>([])
  const [activeCidr, setActiveCidr] = useState<string | null>(null)
  const [layoutConfirm, setLayoutConfirm] = useState(false)
  const [undoEpoch, setUndoEpoch] = useState(0)
  const [trayOpen, setTrayOpen] = useState(() => {
    try {
      return localStorage.getItem(TRAY_STORE_KEY) !== '0'
    } catch {
      return true
    }
  })
  const paneRef = useRef<HTMLDivElement>(null)

  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const sceneIdRef = useRef(0)
  sceneIdRef.current = sceneId
  const sceneTitleRef = useRef(sceneTitle)
  sceneTitleRef.current = sceneTitle
  const liveRef = useRef<MapLiveItem[]>([])
  const saveTimer = useRef<number | null>(null)
  const toastRef = useRef(toast)
  toastRef.current = toast
  const tRef = useRef(t)
  tRef.current = t
  const loadedOnce = useRef(false)
  const groupDrag = useRef<{ id: string; x: number; y: number; members: Array<{ id: string; x: number; y: number }> } | null>(
    null,
  )
  const undoRef = useRef(createUndoStack())

  const selected = useMemo(
    () => mergedNodes.find((n) => n.id === selectedId) ?? null,
    [mergedNodes, selectedId],
  )
  const selectedGroup = useMemo(
    () => scene.groups.find((g) => g.id === selectedGroupId) ?? null,
    [scene.groups, selectedGroupId],
  )
  const shown = useMemo(() => {
    const selectedView = decorateSelection(nodes, edges, selectedId)
    return decorateFocus(selectedView.nodes, selectedView.edges, mergedNodes, searchQuery, activeCidr)
  }, [nodes, edges, selectedId, mergedNodes, searchQuery, activeCidr])
  const neighborOffers = useMemo(
    () => offersFromTopology(selected?.bind, scene, topology),
    [selected?.bind, scene, topology],
  )
  const trayGear = useMemo(() => gearNotOnMap(inventory, scene), [inventory, scene])
  const layers = useMemo(() => subnetLayers(mergedNodes), [mergedNodes])

  const paint = useCallback(
    (next: NetworkMapScene, live = liveRef.current) => {
      const world = toWorldScene(next)
      const hydrated = hydrateScene(world, live)
      setMergedNodes(hydrated.nodes)
      setNodes(toFlowNodes(hydrated.groups, hydrated.nodes))
      setEdges(toFlowEdges(hydrated.edges, hydrated.groups, hydrated.nodes))
      setScene(world)
      sceneRef.current = world
    },
    [setEdges, setNodes],
  )

  const persist = useCallback(
    (next: NetworkMapScene, immediate = false, skipPaint = false, recordUndo = true) => {
      if (!canEdit) return
      if (recordUndo) undoRef.current.push(cloneScene(sceneRef.current))
      if (skipPaint) {
        setScene(next)
        sceneRef.current = next
      } else {
        paint(next)
      }
      setUndoEpoch((n) => n + 1)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      const run = () => {
        setSaving(true)
        void api
          .saveNetworkMapScene({ scene: next, title: sceneTitleRef.current }, sceneIdRef.current)
          .catch((e) => toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed')))
          .finally(() => setSaving(false))
      }
      if (immediate) {
        run()
        return
      }
      saveTimer.current = window.setTimeout(run, 280)
    },
    [canEdit, paint],
  )

  const persistViewport = useCallback(() => {
    if (!canEdit) return
    const next = { ...sceneRef.current, viewport: getViewport() }
    sceneRef.current = next
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      setSaving(true)
      void api
        .saveNetworkMapScene({ scene: next, title: sceneTitleRef.current }, sceneIdRef.current)
        .catch((e) => toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed')))
        .finally(() => setSaving(false))
    }, 1400)
  }, [canEdit, getViewport])

  const refreshLive = useCallback(async (next: NetworkMapScene) => {
    const binds = bindsFromScene(next)
    if (!binds.length) {
      liveRef.current = []
      return
    }
    try {
      const live = await api.networkMapLive(binds)
      liveRef.current = toLive(live.items)
      paint(next, liveRef.current)
    } catch {
      /* scene already visible */
    }
  }, [paint])

  const sceneFromCanvas = useCallback(() => {
    const fromRf = collectScene(getNodes(), getEdges(), sceneRef.current, getViewport())
    if (
      fromRf.nodes.length === 0 &&
      fromRf.groups.length === 0 &&
      (sceneRef.current.nodes.length > 0 || sceneRef.current.groups.length > 0)
    ) {
      return { ...sceneRef.current, viewport: getViewport() }
    }
    return fromRf
  }, [getEdges, getNodes, getViewport])

  const applySceneDto = useCallback(
    (dto: NetworkMapSceneDto, listed?: typeof scenes) => {
      const loaded = (dto.scene as NetworkMapScene) ?? emptyNetworkMapScene()
      const next = { ...emptyNetworkMapScene(), ...loaded, version: 1 as const }
      sceneIdRef.current = dto.id
      setSceneId(dto.id)
      setSceneTitle(dto.title || t('networkMap.title'))
      try {
        localStorage.setItem(SCENE_STORE_KEY, String(dto.id))
      } catch {
        /* ignore */
      }
      paint(next)
      undoRef.current.clear()
      setUndoEpoch((n) => n + 1)
      setSearchQuery('')
      setActiveCidr(null)
      if (next.viewport) setViewport(next.viewport)
      void refreshLive(next)
      if (listed) setScenes(listed)
    },
    [paint, refreshLive, setViewport, t],
  )

  const reloadScenes = useCallback(async () => {
    const listed = await api.listNetworkMapScenes()
    setScenes(listed)
    return listed
  }, [])

  useEffect(() => {
    if (loadedOnce.current) return
    loadedOnce.current = true
    void (async () => {
      setLoading(true)
      try {
        let listed = await api.listNetworkMapScenes()
        let wanted = 0
        try {
          wanted = Number(localStorage.getItem(SCENE_STORE_KEY) || 0)
        } catch {
          wanted = 0
        }
        if (!listed.find((row) => row.id === wanted)) wanted = listed[0]?.id || 0
        if (!wanted && canEdit) {
          const created = await api.createNetworkMapScene({ mode: 'blank', title: t('networkMap.title') })
          listed = await api.listNetworkMapScenes()
          applySceneDto(created, listed)
          return
        }
        const dto = wanted ? await api.networkMapScene(wanted) : await api.networkMapScene()
        applySceneDto(dto, listed)
      } catch (e) {
        toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.loadFailed'))
      } finally {
        setLoading(false)
      }
    })()
  }, [applySceneDto, canEdit, t])

  useEffect(() => {
    let cancelled = false
    void api
      .networkDevices({ limit: 200 })
      .then((rows) => {
        if (!cancelled) setInventory(rows)
      })
      .catch(() => {
        if (!cancelled) setInventory([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const binds = bindsFromScene(scene)
    if (!binds.length) return
    const timer = window.setInterval(() => void refreshLive(sceneRef.current), 45_000)
    return () => window.clearInterval(timer)
  }, [refreshLive, scene.nodes.length])

  useEffect(() => {
    let cancelled = false
    const load = () => {
      void api
        .networkTopology()
        .then((topo) => {
          if (!cancelled) setTopology(topo)
        })
        .catch(() => {
          if (!cancelled) setTopology(null)
        })
        .finally(() => {
          if (!cancelled) setNeighborsBusy(false)
        })
    }
    setNeighborsBusy(true)
    load()
    const timer = window.setInterval(load, 90_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    return onMapNodeResized(() => {
      if (!canEdit) return
      persist(sceneFromCanvas(), false, true)
    })
  }, [canEdit, persist, sceneFromCanvas])

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    if (node.type !== 'groupFrame') {
      groupDrag.current = null
      return
    }
    groupDrag.current = {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      members: sceneRef.current.nodes
        .filter((n) => n.parentGroupId === node.id)
        .map((n) => ({ id: n.id, x: n.x, y: n.y })),
    }
  }, [])

  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      const start = groupDrag.current
      if (!start || node.id !== start.id) return
      const dx = node.position.x - start.x
      const dy = node.position.y - start.y
      const byId = new Map(start.members.map((m) => [m.id, m]))
      setNodes((nds) =>
        nds.map((n) => {
          const mem = byId.get(n.id)
          if (!mem) return n
          return { ...n, position: { x: mem.x + dx, y: mem.y + dy } }
        }),
      )
    },
    [setNodes],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!canEdit) return
      const start = groupDrag.current
      groupDrag.current = null
      if (node.type === 'groupFrame' && start && start.id === node.id) {
        const dx = node.position.x - start.x
        const dy = node.position.y - start.y
        const current = sceneFromCanvas()
        const byId = new Map(start.members.map((m) => [m.id, m]))
        current.nodes = current.nodes.map((n) => {
          if (n.parentGroupId !== node.id) return n
          const mem = byId.get(n.id)
          return mem ? { ...n, x: mem.x + dx, y: mem.y + dy } : { ...n, x: n.x + dx, y: n.y + dy }
        })
        persist(current, false, true)
        return
      }
      if (node.type === 'equipment') {
        const current = sceneFromCanvas()
        current.nodes = current.nodes.map((n) =>
          n.id === node.id ? { ...n, x: node.position.x, y: node.position.y } : n,
        )
        const nested = applyFrameMembership(current, node.id, getNodes())
        persist(nested)
        return
      }
      persist(sceneFromCanvas(), false, true)
    },
    [canEdit, getNodes, persist, sceneFromCanvas],
  )

  const onMoveEnd = useCallback(() => {
    persistViewport()
  }, [persistViewport])

  const canvasCenter = useCallback(() => {
    const pane = paneRef.current
    return viewportFlowCenter(getViewport(), {
      width: pane?.clientWidth || 800,
      height: pane?.clientHeight || 520,
    })
  }, [getViewport])

  const placeAt = useCallback(
    (partial: MergedCanvasNode, flowPos: { x: number; y: number }) => {
      const current = sceneFromCanvas()
      const w = equipmentWidth(partial.stencil, partial.label, partial.width, partial.portCount)
      const h = equipmentHeight(partial.stencil, partial.label, partial.height)
      current.nodes.push({
        id: partial.id,
        stencil: partial.stencil,
        x: flowPos.x,
        y: flowPos.y,
        parentGroupId: null,
        bind: partial.bind ?? null,
        label: partial.label,
        imageSrc: partial.imageSrc ?? null,
        width: partial.width ?? w,
        height: partial.height ?? h,
      })
      persist(current)
      setSelectedId(partial.id)
      setSelectedGroupId(null)
      window.requestAnimationFrame(() => {
        setCenter(flowPos.x + w / 2, flowPos.y + h / 2, {
          duration: 0,
          zoom: Math.max(0.7, Math.min(1.2, getViewport().zoom || 1)),
        })
      })
      if (partial.bind) void refreshLive(current)
    },
    [getViewport, persist, refreshLive, sceneFromCanvas, setCenter],
  )

  const placeGear = useCallback(
    (item: TrayGear, pos?: { x: number; y: number }) => {
      const flowPos = pos ?? canvasCenter()
      placeAt(
        {
          id: bindKey(item.bind),
          stencil: item.stencil,
          x: flowPos.x,
          y: flowPos.y,
          label: item.label,
          bind: item.bind,
          kind: 'network_device',
          missing: false,
        },
        flowPos,
      )
    },
    [canvasCenter, placeAt],
  )

  const placeGroup = useCallback(
    (kind: 'room' | 'rack', pos: { x: number; y: number }) => {
      const current = sceneFromCanvas()
      const id = newId('group')
      current.groups.push({
        id,
        title: kind === 'rack' ? t('networkMap.addRack') : t('networkMap.addRoom'),
        kind,
        x: pos.x,
        y: pos.y,
        width: kind === 'rack' ? 280 : 480,
        height: kind === 'rack' ? 420 : 300,
      })
      persist(current)
      setSelectedId(null)
      setSelectedGroupId(id)
      window.requestAnimationFrame(() => {
        setCenter(pos.x + (kind === 'rack' ? 140 : 240), pos.y + (kind === 'rack' ? 210 : 150), {
          duration: 0,
          zoom: Math.max(0.55, Math.min(1, getViewport().zoom || 1)),
        })
      })
    },
    [getViewport, persist, sceneFromCanvas, setCenter, t],
  )

  const placePayload = useCallback(
    (payload: PaletteDrag, pos: { x: number; y: number }) => {
      if (payload.kind === 'group') {
        placeGroup(payload.groupKind, pos)
        return
      }
      if (payload.kind === 'inventory') {
        placeGear(
          {
            bind: payload.bind,
            label: payload.label,
            ip: payload.ip || null,
            stencil: payload.stencil,
            deviceType: null,
          },
          pos,
        )
        return
      }
      placeAt(
        {
          id: newId('logical'),
          stencil: payload.stencil,
          x: pos.x,
          y: pos.y,
          label: t(`networkMap.stencil.${payload.stencil}` as 'networkMap.stencil.switch'),
          kind: 'logical',
          missing: false,
        },
        pos,
      )
    },
    [placeAt, placeGear, placeGroup, t],
  )

  const placeImage = useCallback(
    async (file: File, pos?: { x: number; y: number }) => {
      if (!canEdit) return
      const current = sceneFromCanvas()
      if (current.nodes.filter((n) => n.stencil === 'image').length >= MAX_MAP_IMAGES) {
        toastRef.current.error(tRef.current('networkMap.imageLimit'))
        return
      }
      try {
        const image = await compressMapImage(file)
        const flowPos = pos ?? canvasCenter()
        placeAt(
          {
            id: newId('logical'),
            stencil: 'image',
            x: flowPos.x,
            y: flowPos.y,
            label: file.name.replace(/\.[^.]+$/, '') || t('networkMap.stencil.image'),
            kind: 'image',
            missing: false,
            imageSrc: image.src,
            width: image.width,
            height: image.height,
          },
          flowPos,
        )
      } catch (e) {
        const code = e instanceof Error ? e.message : ''
        toastRef.current.error(
          tRef.current(code === 'too-large' ? 'networkMap.imageTooBig' : 'networkMap.imageBad'),
        )
      }
    },
    [canEdit, canvasCenter, placeAt, sceneFromCanvas, t],
  )

  const replaceSelectedImage = useCallback(
    async (file: File) => {
      if (!canEdit || !selected || selected.stencil !== 'image') return
      try {
        const image = await compressMapImage(file)
        const current = sceneFromCanvas()
        current.nodes = current.nodes.map((n) =>
          n.id === selected.id ? { ...n, imageSrc: image.src, width: image.width, height: image.height } : n,
        )
        persist(current)
      } catch (e) {
        const code = e instanceof Error ? e.message : ''
        toastRef.current.error(
          tRef.current(code === 'too-large' ? 'networkMap.imageTooBig' : 'networkMap.imageBad'),
        )
      }
    },
    [canEdit, persist, sceneFromCanvas, selected],
  )

  const onDrop = useCallback(
    (event: DragEvent) => {
      event.preventDefault()
      if (!canEdit) return
      const file = event.dataTransfer.files?.[0]
      if (file?.type.startsWith('image/')) {
        void placeImage(file, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
        return
      }
      const raw = event.dataTransfer.getData(NETWORK_MAP_DND) || event.dataTransfer.getData('text/plain')
      if (!raw) return
      let payload: PaletteDrag
      try {
        payload = JSON.parse(raw) as PaletteDrag
      } catch {
        return
      }
      placePayload(payload, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
    },
    [canEdit, placeImage, placePayload, screenToFlowPosition],
  )

  const onDragOver = useCallback((event: DragEvent) => {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!canEdit || !connection.source || !connection.target) return
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            id: newId('scene-edge'),
            type: 'cable',
            data: { persisted: false, linkType: 'manual', linkDbId: null, lane: 0 },
            style: { stroke: 'var(--color-fg)', strokeWidth: 2 },
          },
          eds,
        ),
      )
      window.setTimeout(() => persist(sceneFromCanvas()), 0)
    },
    [canEdit, persist, sceneFromCanvas, setEdges],
  )

  const isValidConnection = useCallback(
    (connection: Connection) => {
      if (!canEdit || !connection.source || !connection.target || connection.source === connection.target) return false
      const nodes = getNodes()
      const source = nodes.find((n) => n.id === connection.source)
      const target = nodes.find((n) => n.id === connection.target)
      if (source?.type !== 'equipment' || target?.type !== 'equipment') return false
      const srcStencil = (source.data as EquipmentNodeData | undefined)?.stencil
      const tgtStencil = (target.data as EquipmentNodeData | undefined)?.stencil
      if (srcStencil === 'note' || srcStencil === 'image' || tgtStencil === 'note' || tgtStencil === 'image') return false
      return true
    },
    [canEdit, getNodes],
  )

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (_removed: Edge[]) => {
      if (!canEdit) return
      window.setTimeout(() => persist(sceneFromCanvas()), 0)
    },
    [canEdit, persist, sceneFromCanvas],
  )

  const onNodesDelete: OnNodesDelete = useCallback(
    (removed: Node[]) => {
      if (!canEdit) return
      const removedIds = new Set(removed.map((n) => n.id))
      window.setTimeout(() => {
        const current = sceneFromCanvas()
        current.nodes = current.nodes
          .filter((n) => !removedIds.has(n.id))
          .map((n) => (n.parentGroupId && removedIds.has(n.parentGroupId) ? { ...n, parentGroupId: null } : n))
        current.groups = current.groups.filter((g) => !removedIds.has(g.id))
        persist(current)
      }, 0)
      setSelectedId(null)
      setSelectedGroupId(null)
    },
    [canEdit, persist, sceneFromCanvas],
  )

  const onDelete = () => {
    if (!selected) return
    const current = sceneFromCanvas()
    current.nodes = current.nodes.filter((n) => n.id !== selected.id)
    current.edges = current.edges.filter((e) => e.source !== selected.id && e.target !== selected.id)
    setSelectedId(null)
    persist(current)
  }

  const onDeleteGroup = () => {
    if (!selectedGroup) return
    const current = sceneFromCanvas()
    current.groups = current.groups.filter((g) => g.id !== selectedGroup.id)
    current.nodes = current.nodes.map((n) => {
      if (n.parentGroupId !== selectedGroup.id) return n
      return { ...n, parentGroupId: null }
    })
    setSelectedGroupId(null)
    persist(current)
  }

  const onLabel = (label: string) => {
    if (!selected) return
    setNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, title: label } } : n)))
    setMergedNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, label } : n)))
    const current = sceneFromCanvas()
    current.nodes = current.nodes.map((n) => (n.id === selected.id ? { ...n, label } : n))
    persist(current)
  }

  const onStencil = (stencil: NetworkMapStencil) => {
    if (!selected) return
    setNodes((ns) =>
      ns.map((n) => (n.id === selected.id ? { ...n, data: { ...n.data, stencil } } : n)),
    )
    setMergedNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, stencil } : n)))
    const current = sceneFromCanvas()
    current.nodes = current.nodes.map((n) => (n.id === selected.id ? { ...n, stencil } : n))
    persist(current)
    const bind = selected.bind
    const dtype = deviceTypeForStencil(stencil)
    if (canEdit && bind?.type === 'network_device' && dtype) {
      void api.patchNetworkDevice(bind.id, { device_type: dtype }).catch((e) => {
        toastRef.current.error(e instanceof Error ? e.message : tRef.current('network.saveFailed'))
      })
    }
  }

  const onBind = (bind: NetworkMapBind | null, extra?: { label?: string; ip?: string | null; stencil?: NetworkMapStencil }) => {
    if (!selected) return
    const current = sceneFromCanvas()
    current.nodes = current.nodes.map((n) =>
      n.id === selected.id
        ? {
            ...n,
            bind,
            label: extra?.label || n.label,
            stencil: extra?.stencil || n.stencil,
          }
        : n,
    )
    persist(current)
    void refreshLive(current)
  }

  const onGroupTitle = (title: string) => {
    if (!selectedGroup) return
    const current = sceneFromCanvas()
    current.groups = current.groups.map((g) => (g.id === selectedGroup.id ? { ...g, title } : g))
    persist(current)
  }

  const onOpenCard = () => {
    if (!selected?.bind) return
    if (selected.bind.type === 'network_device') setDetail({ kind: 'network_device', id: selected.bind.id })
    if (selected.bind.type === 'computer') setDetail({ kind: 'computer', id: selected.bind.id })
    if (selected.bind.type === 'printer') {
      const q = selected.ip || selected.label
      void api.printers({ q, limit: 20 }).then((rows) => {
        const printer = rows.find((p) => p.id === selected.bind?.id)
        if (printer) setDetail({ kind: 'printer', printer })
      })
    }
  }

  const onBlank = () => {
    if (!canEdit) return
    liveRef.current = []
    setSelectedId(null)
    setSelectedGroupId(null)
    setClearOpen(false)
    persist(emptyNetworkMapScene(), true)
  }

  const openScene = async (id: number) => {
    try {
      const listed = await reloadScenes()
      const dto = await api.networkMapScene(id)
      applySceneDto(dto, listed)
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.loadFailed'))
    }
  }

  const createScene = async (mode: 'blank' | 'topology') => {
    if (!canEdit) return
    try {
      const dto = await api.createNetworkMapScene({
        mode,
        title: mode === 'topology' ? t('networkMap.sceneTopologyTitle') : t('networkMap.sceneBlankTitle'),
      })
      const listed = await reloadScenes()
      applySceneDto(dto, listed)
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed'))
    }
  }

  const layoutActive = async () => {
    if (!canEdit || !sceneId) return
    try {
      const dto = await api.layoutNetworkMapScene(sceneId)
      const listed = await reloadScenes()
      applySceneDto(dto, listed)
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed'))
    }
  }

  const applyUndo = useCallback(
    (direction: 'undo' | 'redo') => {
      if (!canEdit) return
      const current = sceneFromCanvas()
      const next = direction === 'undo' ? undoRef.current.undo(current) : undoRef.current.redo(current)
      if (!next) return
      paint(next)
      setUndoEpoch((n) => n + 1)
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => {
        setSaving(true)
        void api
          .saveNetworkMapScene({ scene: next, title: sceneTitleRef.current }, sceneIdRef.current)
          .catch((e) => toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed')))
          .finally(() => setSaving(false))
      }, 280)
    },
    [canEdit, paint, sceneFromCanvas],
  )

  const fitAround = useCallback(
    (ids: string[]) => {
      const unique = [...new Set(ids.filter(Boolean))]
      if (!unique.length) return
      fitView({
        nodes: unique.map((id) => ({ id })),
        padding: 0.22,
        duration: 0,
        maxZoom: 1.35,
      })
    },
    [fitView],
  )

  const jumpSearch = useCallback(() => {
    const hits = mergedNodes.filter((n) => matchMapQuery(n, searchQuery))
    if (!hits.length) return
    setSelectedId(hits[0].id)
    setSelectedGroupId(null)
    fitAround(hits.map((n) => n.id).slice(0, 12))
  }, [fitAround, mergedNodes, searchQuery])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const key = event.key.toLowerCase()
      if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault()
        applyUndo(event.shiftKey ? 'redo' : 'undo')
        return
      }
      if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault()
        applyUndo('redo')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyUndo])

  const applyCluster = useCallback(
    (mode: 'place-missing' | 'gather-all', onlyTopoId?: string) => {
      if (!canEdit || !selectedId) return
      const current = sceneFromCanvas()
      const offers = onlyTopoId ? neighborOffers.filter((o) => o.topoId === onlyTopoId) : neighborOffers
      const next = applyNeighborCluster(current, selectedId, offers, mode)
      persist(next)
      void refreshLive(next)
      window.setTimeout(() => {
        const placed = next.nodes.map((n) => n.id)
        fitAround([selectedId, ...placed.filter((id) => id !== selectedId && offers.some((o) => o.canvasId === id || o.topoId === id))])
      }, 30)
    },
    [canEdit, fitAround, neighborOffers, persist, refreshLive, sceneFromCanvas, selectedId],
  )

  const exportMap = useCallback(async () => {
    const viewportEl = document.querySelector('.network-map-canvas .react-flow__viewport') as HTMLElement | null
    const pane = document.querySelector('.network-map-canvas') as HTMLElement | null
    if (!viewportEl || getNodes().filter((n) => n.type === 'equipment' || n.type === 'groupFrame').length === 0) {
      toastRef.current.error(tRef.current('networkMap.exportPngFailed'))
      return
    }
    setExporting(true)
    pane?.classList.add('is-exporting')
    try {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      await exportNetworkMapPng({ viewportEl, nodes: getNodes(), title: sceneTitleRef.current })
      toastRef.current.ok(tRef.current('networkMap.exportPngOk'))
    } catch {
      toastRef.current.error(tRef.current('networkMap.exportPngFailed'))
    } finally {
      pane?.classList.remove('is-exporting')
      setExporting(false)
    }
  }, [getNodes])

  const renameScene = async (title: string, id = sceneId) => {
    if (!canEdit || !id) return
    try {
      if (id === sceneId) {
        setSceneTitle(title)
        await api.saveNetworkMapScene({ title, scene: sceneFromCanvas() }, id)
      } else {
        const dto = await api.networkMapScene(id)
        await api.saveNetworkMapScene({ title, scene: dto.scene }, id)
      }
      await reloadScenes()
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed'))
    }
  }

  const deleteActive = async (id = sceneId) => {
    if (!canEdit || !id || scenes.length < 2) return
    try {
      await api.deleteNetworkMapScene(id)
      const listed = await reloadScenes()
      if (id === sceneId) {
        const nextId = listed[0]?.id
        if (nextId) await openScene(nextId)
      }
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed'))
    }
  }

  const runTrace = async () => {
    if (!canEdit || !sceneId) {
      toastRef.current.error(tRef.current('networkMap.traceNeedScene'))
      return
    }
    const target = traceTarget.trim()
    if (!target) return
    setTracing(true)
    try {
      const dto = await api.traceNetworkMapScene(sceneId, { target, from_id: selectedId || undefined })
      const listed = await reloadScenes()
      applySceneDto(dto, listed)
      toastRef.current.ok(tRef.current('networkMap.traceOk'))
      window.setTimeout(() => {
        const ids = ((dto.scene as NetworkMapScene)?.nodes || []).map((n) => n.id)
        fitAround(ids.slice(-8))
      }, 40)
    } catch (e) {
      toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.traceFailed'))
    } finally {
      setTracing(false)
    }
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!canEdit) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      const item = [...(event.clipboardData?.items || [])].find((entry) => entry.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void placeImage(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [canEdit, placeImage])

  const empty = nodes.length === 0 && scene.groups.length === 0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--color-bg)]">
      <NetworkMapScenesBar
        canEdit={canEdit}
        scenes={scenes}
        activeId={sceneId}
        title={sceneTitle}
        busy={loading || saving}
        saving={saving}
        search={searchQuery}
        onSearch={setSearchQuery}
        onSearchSubmit={jumpSearch}
        onSelect={(id) => void openScene(id)}
        onCreateBlank={() => void createScene('blank')}
        onCreateTopology={() => void createScene('topology')}
        onLayout={() => setLayoutConfirm(true)}
        onClear={() => setClearOpen(true)}
        onRename={(title, id) => void renameScene(title, id)}
        onDelete={(id) => void deleteActive(id)}
        onExportPng={() => void exportMap()}
        exporting={exporting}
        traceValue={traceTarget}
        onTraceValue={setTraceTarget}
        onTrace={() => void runTrace()}
        tracing={tracing}
        onUndo={() => applyUndo('undo')}
        onRedo={() => applyUndo('redo')}
        canUndo={undoEpoch >= 0 && undoRef.current.canUndo}
        canRedo={undoRef.current.canRedo}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]">
        <NetworkMapTray
          canEdit={canEdit}
          open={trayOpen}
          onOpenChange={(open) => {
            setTrayOpen(open)
            try {
              localStorage.setItem(TRAY_STORE_KEY, open ? '1' : '0')
            } catch {
              /* ignore */
            }
          }}
          trayQuery={trayQuery}
          onTrayQuery={setTrayQuery}
          gear={trayGear}
          layers={layers}
          activeCidr={activeCidr}
          onFilterCidr={(cidr) => {
            setActiveCidr(cidr)
            if (!cidr) return
            const ids = mergedNodes.filter((n) => ipv4Slash24(n.ip) === cidr).map((n) => n.id)
            if (ids.length) fitAround(ids)
          }}
          onPlaceGear={(item) => placeGear(item)}
        />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <div ref={paneRef} className="network-map-canvas relative h-full min-h-0">
            {loading ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--color-bg)] text-sm text-[var(--color-fg-subtle)]">
                {t('common.loading')}
              </div>
            ) : null}
            {!loading && empty && canEdit ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
                <p className="max-w-sm text-center text-sm leading-6 text-[var(--color-fg-muted)]">{t('networkMap.hintEmpty')}</p>
              </div>
            ) : null}
            <ReactFlow
              className={`network-map-canvas h-full ${linking ? 'is-linking' : ''} ${exporting ? 'is-exporting' : ''}`}
              nodes={shown.nodes}
              edges={shown.edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              defaultEdgeOptions={{ type: 'cable' }}
              connectionLineType={ConnectionLineType.SmoothStep}
              connectionLineStyle={{ stroke: 'var(--color-primary)', strokeWidth: 2.2 }}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={36}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onMoveEnd={onMoveEnd}
              onConnectStart={() => setLinking(true)}
              onConnectEnd={() => setLinking(false)}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onEdgesDelete={onEdgesDelete}
              onNodesDelete={onNodesDelete}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onNodeClick={(_, n) => {
                if (n.type === 'groupFrame') {
                  setSelectedGroupId(n.id)
                  setSelectedId(null)
                  return
                }
                setSelectedId(n.type === 'equipment' ? n.id : null)
                setSelectedGroupId(null)
              }}
              onPaneClick={() => {
                setSelectedId(null)
                setSelectedGroupId(null)
              }}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              elementsSelectable
              deleteKeyCode={canEdit ? ['Backspace', 'Delete'] : null}
              onlyRenderVisibleElements
              elevateNodesOnSelect={false}
              snapToGrid
              snapGrid={[20, 20]}
              minZoom={0.08}
              maxZoom={2.4}
              fitView={!scene.viewport}
              fitViewOptions={{ padding: 0.18 }}
              proOptions={RF_PRO}
            >
              <Background
                variant={BackgroundVariant.Lines}
                gap={20}
                size={1}
                color="color-mix(in srgb, var(--color-fg) 7%, transparent)"
              />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
            {selected || selectedGroup ? (
              <div className="network-map-inspector-overlay pointer-events-none absolute inset-y-2 right-2 z-20 flex max-h-full justify-end">
                <div className="pointer-events-auto max-h-full">
                  <NetworkMapInspector
                    overlay
                    canEdit={canEdit}
                    node={selected}
                    group={selected ? null : selectedGroup}
                    neighbors={neighborOffers}
                    neighborsBusy={neighborsBusy}
                    onLabel={onLabel}
                    onStencil={onStencil}
                    onBind={onBind}
                    onDelete={onDelete}
                    onOpenCard={onOpenCard}
                    onGroupTitle={onGroupTitle}
                    onDeleteGroup={onDeleteGroup}
                    onReplaceImage={(file) => void replaceSelectedImage(file)}
                    onPlaceNeighbor={(topoId) => applyCluster('place-missing', topoId)}
                    onFocusNeighbor={(canvasId) => {
                      setSelectedId(canvasId)
                      setSelectedGroupId(null)
                      fitAround([canvasId, selectedId || canvasId])
                    }}
                    onPlaceAllNeighbors={() => applyCluster('place-missing')}
                    onGatherNeighbors={() => applyCluster('gather-all')}
                  />
                </div>
              </div>
            ) : null}
          </div>
          {canEdit ? (
            <NetworkMapDock onPick={(payload) => placePayload(payload, canvasCenter())} onImportImage={(file) => void placeImage(file)} />
          ) : null}
        </div>
      </div>
      {detail?.kind === 'network_device' ? (
        <NetworkDeviceDetailModal
          deviceId={detail.id}
          onClose={() => setDetail(null)}
          onChanged={() => void refreshLive(sceneRef.current)}
        />
      ) : null}
      {detail?.kind === 'computer' ? (
        <ComputerDetailModal
          computerId={detail.id}
          onClose={() => setDetail(null)}
          onChanged={() => void refreshLive(sceneRef.current)}
        />
      ) : null}
      {detail?.kind === 'printer' ? (
        <PrinterDetailModal printer={detail.printer} onClose={() => setDetail(null)} />
      ) : null}
      <NetworkMapClearDialog open={clearOpen} onClose={() => setClearOpen(false)} onConfirm={onBlank} />
      <NetworkMapConfirmDialog
        open={layoutConfirm}
        title={t('networkMap.sceneLayoutConfirmTitle')}
        body={t('networkMap.sceneLayoutConfirmBody')}
        confirmLabel={t('networkMap.sceneLayoutConfirmBtn')}
        onClose={() => setLayoutConfirm(false)}
        onConfirm={() => {
          setLayoutConfirm(false)
          void layoutActive()
        }}
      />
    </div>
  )
}

