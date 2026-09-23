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
  type EdgeChange,
  type EdgeTypes,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnConnect,
  type OnEdgesDelete,
  type OnNodesDelete,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { api, networkMapLiveWebSocketUrl, type NetworkDevice, type NetworkMapLiveItem, type NetworkMapSceneDto, type NetworkPrinter, type NetworkTopology } from '../api'
import { useDiagramLive, type DiagramLiveIconDrag } from '../useDiagramLive'
import { useAuth } from '../AuthContext'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { NetworkDeviceDetailModal } from '../components/NetworkDeviceDetailModal'
import { PrinterDetailModal } from '../components/PrinterDetailModal'
import { useLocale } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { NetworkMapEquipmentNode, NetworkMapGroupNode, type EquipmentNodeData, type GroupNodeData } from './network-map/NetworkMapCanvasNode'
import { NetworkMapCableEdge } from './network-map/NetworkMapCableEdge'
import { NetworkMapClearDialog } from './network-map/NetworkMapClearDialog'
import { NetworkMapConfirmDialog } from './network-map/NetworkMapConfirmDialog'
import { NetworkMapContextMenu, type MapContextAction } from './network-map/NetworkMapContextMenu'
import { NetworkMapDock } from './network-map/NetworkMapDock'
import { NetworkMapInspector } from './network-map/NetworkMapInspector'
import { NetworkMapPortMenu, type MapPortOption } from './network-map/NetworkMapPortMenu'
import { NetworkMapPortPicker } from './network-map/NetworkMapPortPicker'
import { NetworkMapScenesBar } from './network-map/NetworkMapScenesBar'
import { NetworkMapTray } from './network-map/NetworkMapTray'
import {
  addToCanvasPack,
  applyFrameMembership,
  applySceneFrameMembership,
  chassisPorts,
  clampPortCount,
  collectScene,
  decorateFocus,
  decorateSelection,
  defaultStencilPortCount,
  equipmentHeight,
  equipmentWidth,
  followPackLeader,
  isMultiSelectEvent,
  magnetEquipmentPosition,
  lockedSceneIds,
  MAX_CHASSIS_PORTS,
  nextCanvasPackIds,
  nextDiagramSlot,
  nextSlotInGroup,
  occupiedBoxes,
  portHandleId,
  targetPortHandleId,
  portsForPicker,
  RACK_SIZE,
  ROOM_SIZE,
  toFlowEdges,
  toFlowNodes,
  toWorldScene,
  viewportFlowCenter,
} from './network-map/flow'
import { CABLE_STROKE, usedPortsForNode } from './network-map/cables'
import { compressMapImage } from './network-map/image'
import { bindsFromScene, deviceTypeForStencil, hydrateScene, overlayLiveOnMerged } from './network-map/mergeScene'
import { applyNeighborCluster, offersFromTopology } from './network-map/neighborsAround'
import { exportNetworkMapPng } from './network-map/exportPng'
import { onMapNodeResized } from './network-map/NetworkMapResizer'
import { cloneScene, gearNotOnMap, ipv4Slash24, matchMapQuery, subnetLayers, type TrayGear } from './network-map/inventory'
import { createUndoStack } from './network-map/undo'
import { randomId } from '../lib/randomId'
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
  return `${prefix}:${randomId()}`
}

function overlayLiveOnFlow(
  nodes: Node[],
  live: MapLiveItem[],
  edges: Array<{ source: string; target: string; local_port?: string | null; remote_port?: string | null }> = [],
): Node[] {
  const byKey = new Map(live.map((item) => [bindKey({ type: item.type, id: item.id }), item]))
  const pins = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.local_port) pins.set(edge.source, [...(pins.get(edge.source) || []), edge.local_port])
    if (edge.remote_port) pins.set(edge.target, [...(pins.get(edge.target) || []), edge.remote_port])
  }
  return nodes.map((n) => {
    if (n.type !== 'equipment') return n
    const data = n.data as EquipmentNodeData
    if (!data.bind) return n
    const hit = byKey.get(bindKey(data.bind))
    if (!hit) return n
    return {
      ...n,
      data: {
        ...data,
        title: hit.label || data.title,
        subtitle: hit.ip || data.subtitle,
        status: hit.status,
        missing: hit.missing,
        ports: chassisPorts(hit.ports, data.portCount ?? defaultStencilPortCount(data.stencil), pins.get(n.id)),
        portCount: data.portCount,
      },
    }
  })
}

function portFromConnectionHandle(
  handle: string | null | undefined,
  ports: Array<{ id: string; name: string }>,
): string | null {
  if (!handle) return null
  const raw = handle.replace(/-(src|tgt)$/, '')
  const byId = ports.find((p) => p.id === raw || p.id === handle)
  if (byId) return byId.name
  if (!raw.startsWith('p:')) return null
  return ports.find((p) => portHandleId(p.name) === raw)?.name || null
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
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [pendingCable, setPendingCable] = useState<{
    source: string
    target: string
    sourceHandle?: string | null
    targetHandle?: string | null
    sourceLabel: string
    targetLabel: string
    sourcePorts: Array<{ id: string; name: string; up?: boolean | null }>
    targetPorts: Array<{ id: string; name: string; up?: boolean | null }>
    edgeId?: string
    initialLocal?: string | null
    initialRemote?: string | null
  } | null>(null)
  const [linkArmed, setLinkArmed] = useState(false)
  const [linkFrom, setLinkFrom] = useState<{ id: string; port: string | null; label: string; x?: number; y?: number } | null>(null)
  const [portMenu, setPortMenu] = useState<{
    nodeId: string
    label: string
    ports: MapPortOption[]
    used: string[]
    x: number
    y: number
    role: 'from' | 'to'
    targetId?: string
    targetLabel?: string
    edgeId?: string
  } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    kind: 'node' | 'group' | 'edge' | 'pane'
    id?: string
  } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
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
  const loadingRef = useRef(true)
  const groupDrag = useRef<{
    id: string
    x: number
    y: number
    members: Array<{ id: string; x: number; y: number }>
    junctions: Array<{ id: string; points: Array<{ x: number; y: number }> }>
  } | null>(
    null,
  )
  const nodeDragOrigin = useRef<{ id: string; x: number; y: number } | null>(null)
  const undoRef = useRef(createUndoStack())
  const selectedIdsRef = useRef<string[]>([])
  const skipNodeClickRef = useRef(false)
  const packDrag = useRef<{
    leader: string
    origin: { x: number; y: number }
    members: Array<{ id: string; x: number; y: number }>
  } | null>(null)
  const collabBusyRef = useRef(false)
  const lastLocalCommitAtRef = useRef(0)
  const saveGenRef = useRef(0)
  const onRemoteIconDragRef = useRef<((p: DiagramLiveIconDrag) => void) | null>(null)
  const liveDragSent = useRef(0)
  const renameNodeRef = useRef<(id: string, label: string) => void>(() => undefined)
  const renameGroupRef = useRef<(id: string, title: string) => void>(() => undefined)
  const persistRef = useRef<() => void>(() => undefined)
  const selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null
  selectedIdsRef.current = selectedIds
  loadingRef.current = loading

  const selected = useMemo(
    () => mergedNodes.find((n) => n.id === selectedId) ?? null,
    [mergedNodes, selectedId],
  )
  const selectedGroup = useMemo(
    () => scene.groups.find((g) => g.id === selectedGroupId) ?? null,
    [scene.groups, selectedGroupId],
  )
  const selectedCable = useMemo(() => {
    if (!selectedEdgeId) return null
    const sceneEdge = scene.edges.find((e) => e.id === selectedEdgeId)
    const rfEdge = edges.find((e) => e.id === selectedEdgeId)
    const source = sceneEdge?.source || rfEdge?.source
    const target = sceneEdge?.target || rfEdge?.target
    if (!source || !target) return null
    const sourceNode = mergedNodes.find((n) => n.id === source)
    const targetNode = mergedNodes.find((n) => n.id === target)
    const data = rfEdge?.data as { linkType?: string } | undefined
    return {
      id: selectedEdgeId,
      source,
      target,
      sourceLabel: sourceNode?.label || source,
      targetLabel: targetNode?.label || target,
      localPort: sceneEdge?.local_port ?? null,
      remotePort: sceneEdge?.remote_port ?? null,
      linkType: sceneEdge?.link_type || data?.linkType || 'manual',
    }
  }, [selectedEdgeId, scene.edges, edges, mergedNodes])
  const shown = useMemo(() => {
    const selectedView = decorateSelection(nodes, edges, selectedIds, selectedGroupId, selectedEdgeId)
    const focused = decorateFocus(selectedView.nodes, selectedView.edges, mergedNodes, searchQuery, activeCidr)
    if (!canEdit) return focused
    return {
      nodes: focused.nodes.map((n) => {
        if (n.type === 'equipment') {
          return {
            ...n,
            data: {
              ...(n.data as EquipmentNodeData),
              canRename: true,
              onRename: (label: string) => renameNodeRef.current(n.id, label),
            },
          }
        }
        if (n.type === 'groupFrame') {
          return {
            ...n,
            data: {
              ...(n.data as GroupNodeData),
              canRename: true,
              onRename: (title: string) => renameGroupRef.current(n.id, title),
            },
          }
        }
        return n
      }),
      edges: focused.edges.map((edge) => ({
        ...edge,
        data: {
          ...(edge.data as Record<string, unknown>),
          canEdit,
          persistRef,
        },
      })),
    }
  }, [nodes, edges, selectedIds, selectedGroupId, selectedEdgeId, mergedNodes, searchQuery, activeCidr, canEdit])
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
        saveTimer.current = null
        const gen = ++saveGenRef.current
        collabBusyRef.current = true
        lastLocalCommitAtRef.current = Date.now()
        setSaving(true)
        void api
          .saveNetworkMapScene({ scene: next, title: sceneTitleRef.current }, sceneIdRef.current)
          .catch((e) => toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed')))
          .finally(() => {
            if (saveGenRef.current !== gen) return
            setSaving(false)
            collabBusyRef.current = false
            lastLocalCommitAtRef.current = Date.now()
          })
      }
      if (immediate) {
        run()
        return
      }
      collabBusyRef.current = true
      saveTimer.current = window.setTimeout(run, 280)
    },
    [canEdit, paint],
  )

  const persistViewport = useCallback(() => {
    if (!canEdit) return
    const next = { ...sceneRef.current, viewport: getViewport() }
    sceneRef.current = next
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    collabBusyRef.current = true
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      const gen = ++saveGenRef.current
      collabBusyRef.current = true
      lastLocalCommitAtRef.current = Date.now()
      setSaving(true)
      void api
        .saveNetworkMapScene({ scene: next, title: sceneTitleRef.current }, sceneIdRef.current)
        .catch((e) => toastRef.current.error(e instanceof Error ? e.message : tRef.current('networkMap.saveFailed')))
        .finally(() => {
          if (saveGenRef.current !== gen) return
          setSaving(false)
          collabBusyRef.current = false
          lastLocalCommitAtRef.current = Date.now()
        })
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
      const items = toLive(live.items)
      liveRef.current = items
      setMergedNodes((ns) => overlayLiveOnMerged(ns, items, next.edges))
      setNodes((ns) => overlayLiveOnFlow(ns, items, next.edges))
    } catch {
      /* scene already visible */
    }
  }, [setNodes])

  const refetchRemoteScene = useCallback(async () => {
    const id = sceneIdRef.current
    if (!id || collabBusyRef.current || nodeDragOrigin.current || loadingRef.current) return
    try {
      const dto = await api.networkMapScene(id)
      if (collabBusyRef.current || nodeDragOrigin.current || sceneIdRef.current !== id) return
      const loaded = (dto.scene as NetworkMapScene) ?? emptyNetworkMapScene()
      paint({ ...emptyNetworkMapScene(), ...loaded, version: 1 as const, viewport: getViewport() })
    } catch {
      /* keep the canvas already on screen */
    }
  }, [getViewport, paint])

  useEffect(() => {
    onRemoteIconDragRef.current = (msg) => {
      if (user?.id != null && msg.user_id === user.id) return
      const skip = new Set<string>()
      if (nodeDragOrigin.current) skip.add(nodeDragOrigin.current.id)
      const group = groupDrag.current
      if (group) {
        skip.add(group.id)
        for (const member of group.members) skip.add(member.id)
      }
      const pack = packDrag.current
      if (pack) for (const member of pack.members) skip.add(member.id)
      const moves = msg.icons.filter((icon) => !skip.has(icon.id))
      if (!moves.length) return
      const byId = new Map(moves.map((icon) => [icon.id, icon]))
      const frame = sceneRef.current.groups.find((group) => byId.has(group.id))
      const frameHit = frame ? byId.get(frame.id) : undefined
      const frameDx = frame && frameHit ? frameHit.x - frame.x : 0
      const frameDy = frame && frameHit ? frameHit.y - frame.y : 0
      setNodes((nds) =>
        nds.map((n) => {
          const hit = byId.get(n.id)
          return hit ? { ...n, position: { x: hit.x, y: hit.y } } : n
        }),
      )
      if (frameDx || frameDy) {
        setEdges((eds) =>
          eds.map((edge) => {
            const points = (edge.data as { junctions?: Array<{ x: number; y: number }> } | undefined)?.junctions
            if (!points?.length) return edge
            return {
              ...edge,
              data: {
                ...(edge.data as object),
                junctions: points.map((point) => ({ x: point.x + frameDx, y: point.y + frameDy })),
              },
            }
          }),
        )
      }
      const current = sceneRef.current
      sceneRef.current = {
        ...current,
        nodes: current.nodes.map((n) => {
          const hit = byId.get(n.id)
          return hit ? { ...n, x: hit.x, y: hit.y } : n
        }),
        groups: current.groups.map((g) => {
          const hit = byId.get(g.id)
          return hit ? { ...g, x: hit.x, y: hit.y } : g
        }),
      }
    }
  }, [setEdges, setNodes, user?.id])

  const { liveConnected, peers, sendIconDrag } = useDiagramLive({
    diagramId: sceneId > 0 ? sceneId : null,
    enabled: Boolean(user),
    saveState: saving ? 'saving' : 'idle',
    autosaveInFlightRef: collabBusyRef,
    lastLocalCommitAtRef,
    refetchLayout: refetchRemoteScene,
    onRemoteIconDragRef,
    socketUrl: networkMapLiveWebSocketUrl,
  })

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

  const flushSave = useCallback(
    (opts?: { keepalive?: boolean }) => {
      if (!canEdit || loadingRef.current || !sceneIdRef.current) return
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current)
        saveTimer.current = null
      }
      const payload = { ...sceneFromCanvas(), viewport: getViewport() }
      sceneRef.current = payload
      const body = { scene: payload, title: sceneTitleRef.current }
      let keepalive = Boolean(opts?.keepalive)
      if (keepalive) {
        try {
          keepalive = new Blob([JSON.stringify(body)]).size < 60_000
        } catch {
          keepalive = false
        }
      }
      const gen = ++saveGenRef.current
      collabBusyRef.current = true
      lastLocalCommitAtRef.current = Date.now()
      setSaving(true)
      void api
        .saveNetworkMapScene(body, sceneIdRef.current, keepalive ? { keepalive: true } : undefined)
        .finally(() => {
          if (saveGenRef.current !== gen) return
          setSaving(false)
          collabBusyRef.current = false
          lastLocalCommitAtRef.current = Date.now()
        })
    },
    [canEdit, getViewport, sceneFromCanvas],
  )

  useEffect(() => {
    const onUnload = () => flushSave({ keepalive: true })
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    window.addEventListener('pagehide', onUnload)
    window.addEventListener('beforeunload', onUnload)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onUnload)
      window.removeEventListener('beforeunload', onUnload)
      document.removeEventListener('visibilitychange', onHide)
      flushSave({ keepalive: true })
    }
  }, [flushSave])

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

  const selectCanvasNode = useCallback((node: Node, mode: 'replace' | 'add' | 'toggle' = 'replace') => {
    setSelectedEdgeId(null)
    if (node.type === 'groupFrame') {
      if (mode !== 'replace') return
      setSelectedGroupId(node.id)
      selectedIdsRef.current = []
      setSelectedIds([])
      return
    }
    if (node.type !== 'equipment') return
    setSelectedGroupId(null)
    const next =
      mode === 'add'
        ? addToCanvasPack(selectedIdsRef.current, node.id)
        : nextCanvasPackIds(selectedIdsRef.current, node.id, mode === 'toggle')
    selectedIdsRef.current = next
    setSelectedIds(next)
  }, [])

  useEffect(() => {
    const root = paneRef.current
    if (!root) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (linkArmed || linkFrom) return
      const nodeEl = (event.target as HTMLElement | null)?.closest?.('.react-flow__node')
      if (!(nodeEl instanceof HTMLElement)) return
      const id = nodeEl.getAttribute('data-id')
      if (!id) return
      const node = getNodes().find((n) => n.id === id)
      if (!node) return
      if (isMultiSelectEvent(event)) {
        selectCanvasNode(node, 'add')
        return
      }
      if (node.type === 'equipment' && selectedIdsRef.current.length > 1 && selectedIdsRef.current.includes(id)) {
        return
      }
      selectCanvasNode(node, 'replace')
    }
    root.addEventListener('pointerdown', onPointerDown, true)
    return () => root.removeEventListener('pointerdown', onPointerDown, true)
  }, [getNodes, linkArmed, linkFrom, selectCanvasNode])

  const onNodeDragStart = useCallback((event: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, node: Node) => {
    if (lockedSceneIds(sceneRef.current).has(node.id)) {
      packDrag.current = null
      groupDrag.current = null
      return
    }
    skipNodeClickRef.current = true
    nodeDragOrigin.current = { id: node.id, x: node.position.x, y: node.position.y }
    if (node.type === 'groupFrame') {
      selectCanvasNode(node, 'replace')
      packDrag.current = null
      groupDrag.current = {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        members: sceneRef.current.nodes
          .filter((n) => n.parentGroupId === node.id)
          .map((n) => ({ id: n.id, x: n.x, y: n.y })),
        junctions: getEdges().flatMap((edge) => {
          const points = (edge.data as { junctions?: Array<{ x: number; y: number }> } | undefined)?.junctions
          return points?.length ? [{ id: edge.id, points }] : []
        }),
      }
      return
    }
    groupDrag.current = null
    if (node.type === 'equipment') {
      if (isMultiSelectEvent(event) || selectedIdsRef.current.includes(node.id)) {
        selectCanvasNode(node, 'add')
      } else {
        selectCanvasNode(node, 'replace')
      }
    }
    const pack = selectedIdsRef.current.filter((id) => !lockedSceneIds(sceneRef.current).has(id))
    const byId = new Map(getNodes().map((n) => [n.id, n]))
    packDrag.current = {
      leader: node.id,
      origin: { x: node.position.x, y: node.position.y },
      members: pack
        .map((id) => {
          const current = byId.get(id)
          return current ? { id, x: current.position.x, y: current.position.y } : null
        })
        .filter((row): row is { id: string; x: number; y: number } => Boolean(row)),
    }
  }, [getEdges, getNodes, selectCanvasNode])

  const onNodesChangePack = useCallback(
    (changes: NodeChange[]) => {
      const locked = lockedSceneIds(sceneRef.current)
      const open = locked.size ? changes.filter((c) => !(c.type === 'position' && locked.has(c.id))) : changes
      const pack = packDrag.current
      const packIds = pack && pack.members.length > 1 ? new Set(pack.members.map((m) => m.id)) : null
      const kept = packIds
        ? open.map((c) => (c.type === 'select' && packIds.has(c.id) ? { ...c, selected: true } : c))
        : open
      if (!pack || pack.members.length < 2) {
        onNodesChange(kept)
        return
      }
      const leaderChange = kept.find(
        (c) => c.type === 'position' && c.id === pack.leader && 'position' in c && c.position,
      )
      if (!leaderChange || leaderChange.type !== 'position' || !leaderChange.position) {
        onNodesChange(kept)
        return
      }
      const followed = followPackLeader(pack.members, pack.origin, {
        id: pack.leader,
        x: leaderChange.position.x,
        y: leaderChange.position.y,
      })
      const extra: NodeChange[] = followed
        .filter((m) => m.id !== pack.leader)
        .map((m) => ({
          type: 'position',
          id: m.id,
          position: { x: m.x, y: m.y },
          dragging: leaderChange.dragging,
        }))
      onNodesChange([...kept, ...extra])
    },
    [onNodesChange],
  )

  const publishLiveDrag = useCallback(
    (icons: Array<{ id: string; x: number; y: number }>, force = false) => {
      if (!icons.length) return
      const now = performance.now()
      if (!force && now - liveDragSent.current < 30) return
      liveDragSent.current = now
      sendIconDrag(icons)
    },
    [sendIconDrag],
  )

  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      if (lockedSceneIds(sceneRef.current).has(node.id)) return
      const group = groupDrag.current
      if (group && node.id === group.id) {
        const dx = node.position.x - group.x
        const dy = node.position.y - group.y
        const byId = new Map(group.members.map((m) => [m.id, m]))
        setNodes((nds) =>
          nds.map((n) => {
            const mem = byId.get(n.id)
            if (!mem) return n
            return { ...n, position: { x: mem.x + dx, y: mem.y + dy } }
          }),
        )
        if (group.junctions.length) {
          const origins = new Map(group.junctions.map((row) => [row.id, row.points]))
          setEdges((eds) =>
            eds.map((edge) => {
              const points = origins.get(edge.id)
              if (!points) return edge
              return {
                ...edge,
                data: {
                  ...(edge.data as object),
                  junctions: points.map((point) => ({ x: point.x + dx, y: point.y + dy })),
                },
              }
            }),
          )
        }
        publishLiveDrag([
          { id: node.id, x: node.position.x, y: node.position.y },
          ...group.members.map((member) => ({ id: member.id, x: member.x + dx, y: member.y + dy })),
        ])
        return
      }
      const pack = packDrag.current
      if (pack && pack.leader === node.id && pack.members.length >= 2) {
        const followed = followPackLeader(pack.members, pack.origin, {
          id: pack.leader,
          x: node.position.x,
          y: node.position.y,
        })
        const byId = new Map(followed.map((m) => [m.id, m]))
        setNodes((nds) =>
          nds.map((n) => {
            const mem = byId.get(n.id)
            if (!mem || n.id === pack.leader) return n
            return { ...n, position: { x: mem.x, y: mem.y }, selected: true }
          }),
        )
        publishLiveDrag(followed)
        return
      }
      if (node.type !== 'equipment') return
      const data = node.data as EquipmentNodeData
      const live = sceneRef.current.nodes.map((item) =>
        item.id === node.id ? { ...item, x: node.position.x, y: node.position.y } : item,
      )
      const snapped = magnetEquipmentPosition(
        { ...sceneRef.current, nodes: live },
        {
          id: node.id,
          stencil: data.stencil,
          x: node.position.x,
          y: node.position.y,
          width: data.width ?? null,
          height: data.height ?? null,
          label: data.title,
          portCount: data.portCount ?? null,
        },
      )
      const pos = snapped ?? node.position
      publishLiveDrag([{ id: node.id, x: pos.x, y: pos.y }])
      if (!snapped) return
      setNodes((nds) => nds.map((item) => (item.id === node.id ? { ...item, position: snapped } : item)))
    },
    [publishLiveDrag, setEdges, setNodes],
  )

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
      if (!canEdit) return
      const origin = nodeDragOrigin.current
      nodeDragOrigin.current = null
      const moved = Boolean(
        origin &&
          origin.id === node.id &&
          (Math.abs(origin.x - node.position.x) > 1 || Math.abs(origin.y - node.position.y) > 1),
      )
      const start = groupDrag.current
      const pack = packDrag.current
      if (start && node.id === start.id) {
        const dx = node.position.x - start.x
        const dy = node.position.y - start.y
        publishLiveDrag(
          [
            { id: node.id, x: node.position.x, y: node.position.y },
            ...start.members.map((member) => ({ id: member.id, x: member.x + dx, y: member.y + dy })),
          ],
          true,
        )
      } else if (pack && pack.leader === node.id && pack.members.length >= 2) {
        publishLiveDrag(
          followPackLeader(pack.members, pack.origin, {
            id: pack.leader,
            x: node.position.x,
            y: node.position.y,
          }),
          true,
        )
      } else if (origin && origin.id === node.id) {
        publishLiveDrag([{ id: node.id, x: node.position.x, y: node.position.y }], true)
      }
      groupDrag.current = null
      packDrag.current = null
      if (moved) skipNodeClickRef.current = true
      if (!moved) {
        return
      }
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
        const rf = getNodes()
        const pos = new Map(rf.map((n) => [n.id, n.position]))
        current.nodes = current.nodes.map((n) => {
          const next = pos.get(n.id)
          return next ? { ...n, x: next.x, y: next.y } : n
        })
        let nested = current
        const members = pack && pack.members.length > 1 ? pack.members.map((m) => m.id) : [node.id]
        for (const id of members) nested = applyFrameMembership(nested, id, rf)
        for (const id of members) {
          const item = nested.nodes.find((n) => n.id === id)
          if (!item) continue
          const snapped = magnetEquipmentPosition(nested, item)
          if (!snapped) continue
          nested = {
            ...nested,
            nodes: nested.nodes.map((n) => (n.id === id ? { ...n, x: snapped.x, y: snapped.y } : n)),
          }
        }
        persist(nested)
        return
      }
      persist(sceneFromCanvas(), false, true)
    },
    [canEdit, getNodes, persist, publishLiveDrag, sceneFromCanvas],
  )

  const onMoveEnd = useCallback(() => {
    persistViewport()
  }, [persistViewport])

  persistRef.current = () => persist(sceneFromCanvas(), false, true)

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
      const portCount = partial.portCount ?? defaultStencilPortCount(partial.stencil)
      const w = equipmentWidth(partial.stencil, partial.label, partial.width, portCount)
      const h = equipmentHeight(partial.stencil, partial.label, partial.height, portCount)
      const nestedProbe = applySceneFrameMembership(
        {
          ...current,
          nodes: [
            ...current.nodes,
            {
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
              portCount,
            },
          ],
        },
        partial.id,
      )
      const placed = nestedProbe.nodes.find((n) => n.id === partial.id)
      const parentId = placed?.parentGroupId
      const slotted = parentId
        ? nextSlotInGroup(nestedProbe, parentId, { width: w, height: h }, flowPos)
        : nextDiagramSlot(occupiedBoxes(current), flowPos, { width: w, height: h })
      const next = {
        ...nestedProbe,
        nodes: nestedProbe.nodes.map((n) => (n.id === partial.id ? { ...n, x: slotted.x, y: slotted.y } : n)),
      }
      persist(next)
      setSelectedIds([partial.id])
      setSelectedGroupId(null)
      window.requestAnimationFrame(() => {
        setCenter(slotted.x + w / 2, slotted.y + h / 2, {
          duration: 0,
          zoom: Math.max(0.7, Math.min(1.2, getViewport().zoom || 1)),
        })
      })
      if (partial.bind) void refreshLive(next)
    },
    [getViewport, persist, refreshLive, sceneFromCanvas, setCenter],
  )

  const placeGear = useCallback(
    (item: TrayGear, pos?: { x: number; y: number }) => {
      const current = sceneFromCanvas()
      const key = bindKey(item.bind)
      const existing = current.nodes.find((n) => n.bind && bindKey(n.bind) === key)
      if (existing) {
        setSelectedIds([existing.id])
        setSelectedGroupId(null)
        setCenter(existing.x + 56, existing.y + 40, {
          duration: 180,
          zoom: Math.max(0.7, Math.min(1.2, getViewport().zoom || 1)),
        })
        return
      }
      const flowPos = pos ?? canvasCenter()
      placeAt(
        {
          id: key,
          stencil: item.stencil,
          x: flowPos.x,
          y: flowPos.y,
          label: item.label,
          bind: item.bind,
          kind: item.bind.type,
          missing: false,
          portCount: defaultStencilPortCount(item.stencil),
        },
        flowPos,
      )
    },
    [canvasCenter, getViewport, placeAt, sceneFromCanvas, setCenter],
  )

  const placeGroup = useCallback(
    (kind: 'room' | 'rack', pos: { x: number; y: number }) => {
      const current = sceneFromCanvas()
      const id = newId('group')
      const size = kind === 'rack' ? RACK_SIZE : ROOM_SIZE
      const slot = nextDiagramSlot(occupiedBoxes(current), pos, size)
      current.groups.push({
        id,
        title: kind === 'rack' ? t('networkMap.addRack') : t('networkMap.addRoom'),
        kind,
        x: slot.x,
        y: slot.y,
        width: size.width,
        height: size.height,
      })
      persist(current)
      setSelectedIds([])
      setSelectedGroupId(id)
      window.requestAnimationFrame(() => {
        setCenter(slot.x + size.width / 2, slot.y + size.height / 2, {
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
      if (payload.stencil === 'corax') {
        placeGear(
          {
            bind: { type: 'corax', id: 0 },
            label: t('networkMap.stencil.corax'),
            ip: null,
            stencil: 'corax',
            deviceType: 'corax',
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
          portCount: defaultStencilPortCount(payload.stencil),
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

  const commitCable = useCallback(
    (
      connection: Connection,
      localPort: string | null,
      remotePort: string | null,
      edgeId?: string,
    ) => {
      if (!connection.source || !connection.target) return
      if (edgeId) {
        const current = sceneFromCanvas()
        current.edges = current.edges.map((e) =>
          e.id === edgeId
            ? {
                ...e,
                source: connection.source as string,
                target: connection.target as string,
                local_port: localPort,
                remote_port: remotePort,
              }
            : e,
        )
        persist(current)
        return
      }
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            sourceHandle: localPort ? portHandleId(localPort) || connection.sourceHandle : connection.sourceHandle,
            targetHandle: remotePort ? targetPortHandleId(remotePort) || connection.targetHandle : connection.targetHandle,
            id: newId('scene-edge'),
            type: 'cable',
            data: { persisted: false, linkType: 'manual', linkDbId: null, lane: 0 },
            style: { stroke: CABLE_STROKE, strokeWidth: 2.35 },
          },
          eds,
        ),
      )
      window.setTimeout(() => persist(sceneFromCanvas()), 0)
    },
    [persist, sceneFromCanvas, setEdges],
  )

  const clearCableJob = useCallback(() => {
    setLinkArmed(false)
    setLinkFrom(null)
    setPortMenu(null)
    setLinking(false)
    setPendingCable(null)
  }, [])

  const portsOfNode = useCallback((node: Node | undefined): MapPortOption[] => {
    const data = node?.data as EquipmentNodeData | undefined
    return portsForPicker(chassisPorts(data?.ports, data?.portCount), MAX_CHASSIS_PORTS)
  }, [])

  const openPortMenu = useCallback(
    (
      node: Node,
      client: { x: number; y: number },
      role: 'from' | 'to',
      extra?: { targetId?: string; targetLabel?: string; edgeId?: string },
    ) => {
      const data = node.data as EquipmentNodeData | undefined
      if (!data || data.stencil === 'note' || data.stencil === 'image') return
      const ports = portsOfNode(node)
      setPortMenu({
        nodeId: node.id,
        label: data.title || node.id,
        ports,
        used: [...usedPortsForNode(sceneRef.current.edges, node.id, extra?.edgeId)],
        x: client.x,
        y: client.y,
        role,
        targetId: extra?.targetId,
        targetLabel: extra?.targetLabel,
        edgeId: extra?.edgeId,
      })
    },
    [portsOfNode],
  )

  const finishCable = useCallback(
    (sourceId: string, targetId: string, localPort: string | null, remotePort: string | null, edgeId?: string) => {
      commitCable(
        {
          source: sourceId,
          target: targetId,
          sourceHandle: localPort ? portHandleId(localPort) ?? null : null,
          targetHandle: remotePort ? targetPortHandleId(remotePort) ?? null : null,
        },
        localPort,
        remotePort,
        edgeId,
      )
      clearCableJob()
    },
    [clearCableJob, commitCable],
  )

  const onPickPort = useCallback(
    (port: string | null) => {
      if (!portMenu) return
      if (portMenu.role === 'from') {
        const sourceId = portMenu.nodeId
        const sourceLabel = portMenu.label
        const pendingTarget = portMenu.targetId
        const box = paneRef.current?.getBoundingClientRect()
        setLinkFrom({
          id: sourceId,
          port,
          label: sourceLabel,
          x: portMenu.x - (box?.left || 0),
          y: portMenu.y - (box?.top || 0),
        })
        setLinkArmed(true)
        if (pendingTarget) {
          const target = getNodes().find((n) => n.id === pendingTarget)
          if (target) {
            openPortMenu(target, { x: portMenu.x + 16, y: portMenu.y + 16 }, 'to', {
              edgeId: portMenu.edgeId,
            })
            return
          }
        }
        setPortMenu(null)
        return
      }
      if (!linkFrom || linkFrom.id === portMenu.nodeId) {
        setPortMenu(null)
        return
      }
      finishCable(linkFrom.id, portMenu.nodeId, linkFrom.port, port, portMenu.edgeId)
    },
    [finishCable, getNodes, linkFrom, openPortMenu, portMenu],
  )

  const beginCableOnNode = useCallback(
    (node: Node, client: { x: number; y: number }) => {
      const data = node.data as EquipmentNodeData | undefined
      if (node.type !== 'equipment' || !data || data.stencil === 'note' || data.stencil === 'image') return
      setLinking(true)
      setCtxMenu(null)
      if (!linkFrom) {
        setLinkArmed(true)
        openPortMenu(node, client, 'from')
        return
      }
      if (linkFrom.id === node.id) {
        openPortMenu(node, client, 'from')
        return
      }
      openPortMenu(node, client, 'to')
    },
    [linkFrom, openPortMenu],
  )

  const armCableTool = useCallback(() => {
    if (linkArmed || linkFrom) {
      clearCableJob()
      return
    }
    setLinkArmed(true)
    setLinkFrom(null)
    setPortMenu(null)
    setCtxMenu(null)
    setSelectedEdgeId(null)
    setLinking(true)
  }, [clearCableJob, linkArmed, linkFrom])

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (!canEdit || !connection.source || !connection.target) return
      const rf = getNodes()
      const source = rf.find((n) => n.id === connection.source)
      const target = rf.find((n) => n.id === connection.target)
      if (!source || !target) return
      const sourcePorts = portsOfNode(source)
      const targetPorts = portsOfNode(target)
      const sourcePort = portFromConnectionHandle(connection.sourceHandle, sourcePorts)
      const targetPort = portFromConnectionHandle(connection.targetHandle, targetPorts)
      if ((sourcePort || !sourcePorts.length) && (targetPort || !targetPorts.length)) {
        finishCable(connection.source, connection.target, sourcePort, targetPort)
        return
      }
      setLinkArmed(true)
      setLinking(true)
      if (sourcePort || !sourcePorts.length) {
        setLinkFrom({
          id: connection.source,
          port: sourcePort,
          label: (source.data as EquipmentNodeData).title || connection.source,
        })
        openPortMenu(target, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 'to')
        return
      }
      setLinkFrom(null)
      openPortMenu(source, { x: window.innerWidth / 2, y: window.innerHeight / 2 }, 'from', {
        targetId: connection.target,
        targetLabel: (target.data as EquipmentNodeData).title || connection.target,
      })
    },
    [canEdit, finishCable, getNodes, openPortMenu, portsOfNode],
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

  const onEdgesChangeKeep = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes.filter((change) => change.type !== 'remove'))
    },
    [onEdgesChange],
  )

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (removed: Edge[]) => {
      if (!canEdit) return
      const gone = new Set(removed.map((e) => e.id))
      setSelectedEdgeId((id) => (id && gone.has(id) ? null : id))
      window.setTimeout(() => {
        const current = sceneFromCanvas()
        current.edges = current.edges.filter((edge) => !gone.has(edge.id))
        persist(current)
      }, 0)
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
        current.edges = current.edges.filter((e) => !removedIds.has(e.source) && !removedIds.has(e.target) && !removedIds.has(e.id))
        persist(current)
      }, 0)
      setSelectedIds([])
      setSelectedGroupId(null)
      setSelectedEdgeId(null)
    },
    [canEdit, persist, sceneFromCanvas],
  )

  const onDelete = () => {
    const ids = new Set(selectedIds.length ? selectedIds : selected ? [selected.id] : [])
    const groupIds = new Set(selectedGroupId ? [selectedGroupId] : [])
    if (!ids.size && !groupIds.size) return
    const current = sceneFromCanvas()
    current.nodes = current.nodes
      .filter((n) => !ids.has(n.id))
      .map((n) => (n.parentGroupId && groupIds.has(n.parentGroupId) ? { ...n, parentGroupId: null } : n))
    current.groups = current.groups.filter((g) => !groupIds.has(g.id))
    current.edges = current.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target))
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
    persist(current)
  }

  const onDeleteCable = () => {
    if (!canEdit || !selectedEdgeId) return
    const current = sceneFromCanvas()
    current.edges = current.edges.filter((e) => e.id !== selectedEdgeId)
    setSelectedEdgeId(null)
    persist(current)
  }

  const onEditCablePorts = () => {
    if (!canEdit || !selectedCable) return
    const source = getNodes().find((n) => n.id === selectedCable.source)
    if (!source) return
    setLinkArmed(true)
    setLinkFrom(null)
    openPortMenu(source, { x: window.innerWidth / 2 - 40, y: 120 }, 'from', {
      targetId: selectedCable.target,
      targetLabel: selectedCable.targetLabel,
      edgeId: selectedCable.id,
    })
  }

  const onResetCableBend = () => {
    if (!canEdit || !selectedEdgeId) return
    const current = sceneFromCanvas()
    current.edges = current.edges.map((e) => (e.id === selectedEdgeId ? { ...e, points: [] } : e))
    persist(current)
  }

  const onPortCount = (count: number | null) => {
    if (!selected) return
    const portCount = clampPortCount(count)
    const keptW = equipmentWidth(selected.stencil, selected.label, selected.width, selected.portCount)
    const keptH = equipmentHeight(selected.stencil, selected.label, selected.height, selected.portCount)
    const w = keptW
    const h = equipmentHeight(selected.stencil, selected.label, keptH, portCount)
    const pinned = sceneRef.current.edges.flatMap((edge) => {
      if (edge.source === selected.id && edge.local_port) return [edge.local_port]
      if (edge.target === selected.id && edge.remote_port) return [edge.remote_port]
      return []
    })
    const ports = chassisPorts(selected.ports, portCount, pinned)
    setNodes((ns) =>
      ns.map((n) =>
        n.id === selected.id
          ? {
              ...n,
              data: { ...n.data, portCount, ports, width: w, height: h },
              style: { ...n.style, width: w, height: h },
            }
          : n,
      ),
    )
    setMergedNodes((ns) => ns.map((n) => (n.id === selected.id ? { ...n, portCount, ports, width: w, height: h } : n)))
    const current = sceneFromCanvas()
    current.nodes = current.nodes.map((n) => (n.id === selected.id ? { ...n, portCount, width: w, height: h } : n))
    persist(current)
  }

  const toggleLock = (nodeIds: string[], groupIds: string[]) => {
    const current = sceneFromCanvas()
    const nodeSet = new Set(nodeIds)
    const groupSet = new Set(groupIds)
    const flags = [
      ...nodeIds.map((id) => Boolean(current.nodes.find((n) => n.id === id)?.locked)),
      ...groupIds.map((id) => Boolean(current.groups.find((g) => g.id === id)?.locked)),
    ]
    if (!flags.length) return
    const next = flags.some((locked) => !locked)
    current.nodes = current.nodes.map((n) => (nodeSet.has(n.id) ? { ...n, locked: next || undefined } : n))
    current.groups = current.groups.map((g) => (groupSet.has(g.id) ? { ...g, locked: next || undefined } : g))
    persist(current)
  }

  const onGroupSize = (width: number, height: number) => {
    if (!selectedGroup) return
    const current = sceneFromCanvas()
    current.groups = current.groups.map((g) => (g.id === selectedGroup.id ? { ...g, width, height } : g))
    persist(current)
  }

  const duplicateNode = (id: string) => {
    const current = sceneFromCanvas()
    const node = current.nodes.find((n) => n.id === id)
    if (!node) return
    const copyId = newId('logical')
    const w = equipmentWidth(node.stencil, node.label || '', node.width, node.portCount)
    const h = equipmentHeight(node.stencil, node.label || '', node.height, node.portCount)
    const slot = nextDiagramSlot(occupiedBoxes(current), { x: node.x + 36, y: node.y + 28 }, { width: w, height: h })
    current.nodes.push({
      ...node,
      id: copyId,
      x: slot.x,
      y: slot.y,
      bind: null,
      label: node.label ? `${node.label} 2` : node.id,
      locked: undefined,
    })
    persist(applySceneFrameMembership(current, copyId))
    setSelectedIds([copyId])
    setSelectedGroupId(null)
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

  const onLabel = (label: string, id = selectedId) => {
    if (!id) return
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title: label } } : n)))
    setMergedNodes((ns) => ns.map((n) => (n.id === id ? { ...n, label } : n)))
    const current = sceneFromCanvas()
    current.nodes = current.nodes.map((n) => (n.id === id ? { ...n, label } : n))
    persist(current)
  }

  const onGroupTitle = (title: string, id = selectedGroupId) => {
    if (!id) return
    const current = sceneFromCanvas()
    current.groups = current.groups.map((g) => (g.id === id ? { ...g, title } : g))
    persist(current)
  }

  renameNodeRef.current = (id, label) => onLabel(label, id)
  renameGroupRef.current = (id, title) => onGroupTitle(title, id)

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

  const ctxActions = useMemo((): MapContextAction[] => {
    if (!ctxMenu || !canEdit) return []
    if (ctxMenu.kind === 'pane') {
      return [
        { id: 'cable', label: t('networkMap.ctxConnect') },
        { id: 'room', label: t('networkMap.addRoom') },
        { id: 'rack', label: t('networkMap.addRack') },
      ]
    }
    if (ctxMenu.kind === 'edge') {
      return [
        { id: 'ports', label: t('networkMap.editCablePorts') },
        { id: 'unbend', label: t('networkMap.resetCableBend') },
        { id: 'delete', label: t('networkMap.deleteCable'), danger: true },
      ]
    }
    if (ctxMenu.kind === 'group') {
      const group = scene.groups.find((g) => g.id === ctxMenu.id)
      return [
        { id: 'lock', label: group?.locked ? t('networkMap.unlock') : t('networkMap.lock') },
        { id: 'select-inside', label: t('networkMap.ctxSelectInside') },
        { id: 'delete-group', label: t('networkMap.remove'), danger: true },
      ]
    }
    const node = mergedNodes.find((n) => n.id === ctxMenu.id)
    const connectable = node && node.stencil !== 'note' && node.stencil !== 'image'
    return [
      { id: 'lock', label: node?.locked ? t('networkMap.unlock') : t('networkMap.lock') },
      ...(connectable ? [{ id: 'connect', label: t('networkMap.ctxConnect') }] : []),
      { id: 'duplicate', label: t('networkMap.ctxDuplicate') },
      ...(node?.bind && node.bind.type !== 'corax' && node.bind.type !== 'zabbix'
        ? [{ id: 'card', label: t('networkMap.openCard') }]
        : []),
      { id: 'delete', label: t('networkMap.remove'), danger: true },
    ]
  }, [canEdit, ctxMenu, mergedNodes, scene.groups, t])

  const runContext = (action: string) => {
    const menu = ctxMenu
    setCtxMenu(null)
    if (!menu) return
    const flowPos = screenToFlowPosition({ x: menu.x, y: menu.y })
    if (action === 'cable') {
      armCableTool()
      return
    }
    if (action === 'room') {
      placeGroup('room', flowPos)
      return
    }
    if (action === 'rack') {
      placeGroup('rack', flowPos)
      return
    }
    if (action === 'connect' && menu.id) {
      const node = getNodes().find((n) => n.id === menu.id)
      if (node) beginCableOnNode(node, { x: menu.x, y: menu.y })
      return
    }
    if (action === 'duplicate' && menu.id) {
      duplicateNode(menu.id)
      return
    }
    if (action === 'card' && menu.id) {
      setSelectedIds([menu.id])
      setSelectedGroupId(null)
      const node = mergedNodes.find((n) => n.id === menu.id)
      if (!node?.bind) return
      if (node.bind.type === 'network_device') setDetail({ kind: 'network_device', id: node.bind.id })
      if (node.bind.type === 'computer') setDetail({ kind: 'computer', id: node.bind.id })
      return
    }
    if (action === 'delete' && menu.kind === 'node' && menu.id) {
      setSelectedIds([menu.id])
      setSelectedGroupId(null)
      const current = sceneFromCanvas()
      current.nodes = current.nodes.filter((n) => n.id !== menu.id)
      current.edges = current.edges.filter((e) => e.source !== menu.id && e.target !== menu.id)
      persist(current)
      setSelectedIds([])
      return
    }
    if (action === 'ports' && menu.id) {
      const edge = sceneRef.current.edges.find((e) => e.id === menu.id)
      const source = getNodes().find((n) => n.id === edge?.source)
      if (source && edge) {
        setSelectedEdgeId(edge.id)
        setLinkArmed(true)
        setLinkFrom(null)
        openPortMenu(source, { x: menu.x, y: menu.y }, 'from', {
          targetId: edge.target,
          edgeId: edge.id,
        })
      }
      return
    }
    if (action === 'unbend' && menu.id) {
      const current = sceneFromCanvas()
      current.edges = current.edges.map((e) => (e.id === menu.id ? { ...e, points: [] } : e))
      persist(current)
      return
    }
    if (action === 'delete' && menu.kind === 'edge' && menu.id) {
      const current = sceneFromCanvas()
      current.edges = current.edges.filter((e) => e.id !== menu.id)
      setSelectedEdgeId(null)
      persist(current)
      return
    }
    if (action === 'lock' && menu.id) {
      if (menu.kind === 'group') toggleLock([], [menu.id])
      else toggleLock([menu.id], [])
      return
    }
    if (action === 'select-inside' && menu.id) {
      const ids = sceneRef.current.nodes.filter((n) => n.parentGroupId === menu.id).map((n) => n.id)
      setSelectedGroupId(menu.id)
      setSelectedIds(ids)
      setSelectedEdgeId(null)
      return
    }
    if (action === 'delete-group' && menu.id) {
      setSelectedGroupId(menu.id)
      const current = sceneFromCanvas()
      current.groups = current.groups.filter((g) => g.id !== menu.id)
      current.nodes = current.nodes.map((n) => (n.parentGroupId === menu.id ? { ...n, parentGroupId: null } : n))
      persist(current)
      setSelectedGroupId(null)
    }
  }

  const onBlank = () => {
    if (!canEdit) return
    liveRef.current = []
    setSelectedIds([])
    setSelectedGroupId(null)
    setSelectedEdgeId(null)
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
    setSelectedIds([hits[0].id])
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
        return
      }
      if (canEdit && (event.key === 'Escape')) {
        if (linkArmed || linkFrom || portMenu) {
          event.preventDefault()
          clearCableJob()
        }
        setCtxMenu(null)
        return
      }
      if (canEdit && (event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) {
        event.preventDefault()
        const current = sceneFromCanvas()
        current.edges = current.edges.filter((e) => e.id !== selectedEdgeId)
        setSelectedEdgeId(null)
        persist(current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [applyUndo, canEdit, clearCableJob, linkArmed, linkFrom, persist, portMenu, sceneFromCanvas, selectedEdgeId])

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
        liveConnected={liveConnected}
        peers={user ? peers : undefined}
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
            <div
              ref={paneRef}
              className="network-map-canvas relative h-full min-h-0"
              onMouseMove={(event) => {
                if (linkFrom) setCursor({ x: event.clientX - event.currentTarget.getBoundingClientRect().left, y: event.clientY - event.currentTarget.getBoundingClientRect().top })
              }}
            >
            {loading ? (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-[var(--color-bg-muted)]/90 text-sm text-[var(--color-fg-muted)]">
                {t('common.loading')}
              </div>
            ) : null}
            {!loading && empty && canEdit ? (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
                <p className="max-w-sm text-center text-sm leading-6 text-[var(--color-fg-muted)]">{t('networkMap.hintEmpty')}</p>
              </div>
            ) : null}
            {selectedIds.length > 1 ? (
              <div className="pointer-events-none absolute left-2 top-2 z-20 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-[11px] font-semibold text-[var(--color-fg)]">
                {t('networkMap.selectedCount', { n: selectedIds.length })}
              </div>
            ) : null}
            {linkArmed || linkFrom || portMenu ? (
              <div className="network-map-link-hint px-3 py-1.5 text-[12px] font-medium">
                {portMenu
                  ? t('networkMap.cablePickPort', { name: portMenu.label })
                  : linkFrom
                    ? t('networkMap.cablePickSecond')
                    : t('networkMap.cablePickDevice')}
                <span className="ml-2 text-[11px] font-normal text-[var(--color-fg-subtle)]">{t('networkMap.cableCancel')}</span>
              </div>
            ) : null}
            {linkFrom && cursor && !portMenu ? (
              <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full">
                <line
                  x1={linkFrom.x ?? cursor.x}
                  y1={linkFrom.y ?? cursor.y}
                  x2={cursor.x}
                  y2={cursor.y}
                  stroke={CABLE_STROKE}
                  strokeWidth="2"
                  strokeDasharray="6 6"
                />
              </svg>
            ) : null}
            <ReactFlow
              className={`network-map-canvas h-full ${linking || linkArmed || linkFrom ? 'is-linking is-cabling' : ''} ${exporting ? 'is-exporting' : ''}`}
              nodes={shown.nodes}
              edges={shown.edges}
              nodeTypes={NODE_TYPES}
              edgeTypes={EDGE_TYPES}
              defaultEdgeOptions={{ type: 'cable' }}
              connectionLineType={ConnectionLineType.SmoothStep}
              connectionLineStyle={{ stroke: CABLE_STROKE, strokeWidth: 2.2 }}
              connectionMode={ConnectionMode.Loose}
              connectionRadius={36}
              onNodesChange={onNodesChangePack}
              onEdgesChange={onEdgesChangeKeep}
              onNodeDragStart={onNodeDragStart}
              onNodeDrag={onNodeDrag}
              onNodeDragStop={onNodeDragStop}
              onMoveEnd={onMoveEnd}
              onConnectStart={() => setLinking(true)}
              onConnectEnd={() => {
                if (!linkArmed && !linkFrom) setLinking(false)
              }}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onEdgesDelete={onEdgesDelete}
              onNodesDelete={onNodesDelete}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onNodeClick={(event, n) => {
                event.stopPropagation()
                if (linkArmed || linkFrom) {
                  beginCableOnNode(n, { x: event.clientX, y: event.clientY })
                  return
                }
                if (skipNodeClickRef.current) {
                  skipNodeClickRef.current = false
                  return
                }
                if (isMultiSelectEvent(event)) {
                  selectCanvasNode(n, 'add')
                  return
                }
                if (n.type === 'equipment' && selectedIdsRef.current.length > 1 && selectedIdsRef.current.includes(n.id)) {
                  return
                }
                selectCanvasNode(n, 'replace')
              }}
              onNodeContextMenu={(event, n) => {
                if (!canEdit) return
                event.preventDefault()
                event.stopPropagation()
                setCtxMenu({
                  x: event.clientX,
                  y: event.clientY,
                  kind: n.type === 'groupFrame' ? 'group' : 'node',
                  id: n.id,
                })
              }}
              onEdgeContextMenu={(event, edge) => {
                if (!canEdit) return
                event.preventDefault()
                event.stopPropagation()
                setSelectedEdgeId(edge.id)
                setCtxMenu({ x: event.clientX, y: event.clientY, kind: 'edge', id: edge.id })
              }}
              onPaneContextMenu={(event) => {
                if (!canEdit) return
                event.preventDefault()
                setCtxMenu({ x: event.clientX, y: event.clientY, kind: 'pane' })
              }}
              onEdgeClick={(event, edge) => {
                event.stopPropagation()
                if (linkArmed || linkFrom) return
                setSelectedIds([])
                selectedIdsRef.current = []
                setSelectedGroupId(null)
                setSelectedEdgeId(edge.id)
              }}
              onPaneClick={(event) => {
                const target = event.target as HTMLElement | null
                if (target?.closest('.react-flow__node')) return
                if (target?.closest('.react-flow__edge')) return
                if (linkArmed || linkFrom || portMenu) {
                  clearCableJob()
                  return
                }
                setSelectedIds([])
                selectedIdsRef.current = []
                setSelectedGroupId(null)
                setSelectedEdgeId(null)
                setCtxMenu(null)
              }}
              nodesDraggable={canEdit}
              nodesConnectable={canEdit}
              elementsSelectable
              edgesFocusable
              selectNodesOnDrag={false}
              selectionOnDrag={false}
              selectionKeyCode="Shift"
              nodeDragThreshold={5}
              multiSelectionKeyCode={['Shift', 'Control', 'Meta']}
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
              <Background variant={BackgroundVariant.Dots} gap={20} size={1.4} color="#94a3b8" />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
            {selected || selectedGroup || selectedCable ? (
              <div className="network-map-inspector-overlay pointer-events-none absolute inset-y-2 right-2 z-20 flex max-h-full justify-end">
                <div className="pointer-events-auto max-h-full">
                  <NetworkMapInspector
                    overlay
                    canEdit={canEdit}
                    node={selected}
                    group={selected ? null : selectedGroup}
                    edge={selected ? null : selectedCable}
                    neighbors={neighborOffers}
                    neighborsBusy={neighborsBusy}
                    onLabel={onLabel}
                    onStencil={onStencil}
                    onBind={onBind}
                    onDelete={onDelete}
                    onOpenCard={onOpenCard}
                    onGroupTitle={onGroupTitle}
                    onDeleteGroup={onDeleteGroup}
                    onDeleteCable={onDeleteCable}
                    onEditCablePorts={onEditCablePorts}
                    onReplaceImage={(file) => void replaceSelectedImage(file)}
                    onPlaceNeighbor={(topoId) => applyCluster('place-missing', topoId)}
                    onFocusNeighbor={(canvasId) => {
                      setSelectedIds([canvasId])
                      setSelectedGroupId(null)
                      setSelectedEdgeId(null)
                      fitAround([canvasId, selectedId || canvasId])
                    }}
                    onPlaceAllNeighbors={() => applyCluster('place-missing')}
                    onGatherNeighbors={() => applyCluster('gather-all')}
                    selectionCount={selectedIds.length + (selectedGroupId ? 1 : 0)}
                    onPortCount={onPortCount}
                    onGroupSize={onGroupSize}
                    onResetCableBend={onResetCableBend}
                    onToggleLock={() => {
                      if (selectedIds.length > 1) toggleLock(selectedIds, selectedGroupId ? [selectedGroupId] : [])
                      else if (selected) toggleLock([selected.id], [])
                      else if (selectedGroup) toggleLock([], [selectedGroup.id])
                    }}
                    selectionAllLocked={
                      selectedIds.length > 1
                        ? selectedIds.every((id) => scene.nodes.find((n) => n.id === id)?.locked)
                        : Boolean(selected?.locked || selectedGroup?.locked)
                    }
                  />
                </div>
              </div>
            ) : null}
          </div>
          {canEdit ? (
            <NetworkMapDock
              onPick={(payload) => placePayload(payload, canvasCenter())}
              onImportImage={(file) => void placeImage(file)}
              onCableTool={armCableTool}
              cableActive={linkArmed || Boolean(linkFrom) || Boolean(portMenu)}
            />
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
      {portMenu ? (
        <NetworkMapPortMenu
          open
          title={portMenu.label}
          hint={t('networkMap.cablePickPort', { name: portMenu.label })}
          ports={portMenu.ports}
          used={portMenu.used}
          x={portMenu.x}
          y={portMenu.y}
          onPick={onPickPort}
          onClose={() => {
            if (portMenu.role === 'to' && linkFrom) {
              setPortMenu(null)
              return
            }
            clearCableJob()
          }}
        />
      ) : null}
      {ctxMenu && ctxActions.length ? (
        <NetworkMapContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          actions={ctxActions}
          onPick={runContext}
          onClose={() => setCtxMenu(null)}
        />
      ) : null}
      {pendingCable ? (
        <NetworkMapPortPicker
          key={`${pendingCable.edgeId || 'new'}:${pendingCable.source}:${pendingCable.target}`}
          open
          sourceLabel={pendingCable.sourceLabel}
          targetLabel={pendingCable.targetLabel}
          sourcePorts={pendingCable.sourcePorts}
          targetPorts={pendingCable.targetPorts}
          initialLocal={pendingCable.initialLocal}
          initialRemote={pendingCable.initialRemote}
          confirmLabel={pendingCable.edgeId ? t('networkMap.portPickSave') : undefined}
          onClose={() => setPendingCable(null)}
          onConfirm={(localPort, remotePort) => {
            commitCable(
              {
                source: pendingCable.source,
                target: pendingCable.target,
                sourceHandle: pendingCable.sourceHandle ?? null,
                targetHandle: pendingCable.targetHandle ?? null,
              },
              localPort,
              remotePort,
              pendingCable.edgeId,
            )
            setPendingCable(null)
          }}
        />
      ) : null}
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

