import { type Edge, type Node } from 'reactflow'
import { CABLE_STROKE, cableStrokeColor, laneForEdges, sanitizeCablePoints } from './cables'
import {
  chassisPortLayout,
  chassisPorts,
  clampPortCount,
  defaultStencilPortCount,
  equipmentHeight,
  equipmentWidth,
  magnetInFrame,
  MAX_CHASSIS_PORTS,
  nextDiagramSlot,
  nextSlotInGroup,
  occupiedBoxes,
  portHandleId,
  targetPortHandleId,
  RACK_SIZE,
  ROOM_SIZE,
} from './chassis'
import { ipv4Slash24, matchMapQuery } from './inventory'
import type { MergedCanvasEdge, MergedCanvasNode, NetworkMapGroup, NetworkMapScene } from './types'
import type { EquipmentNodeData, GroupNodeData } from './NetworkMapCanvasNode'

export {
  chassisPortLayout,
  chassisPorts,
  clampPortCount,
  defaultStencilPortCount,
  equipmentHeight,
  equipmentWidth,
  magnetInFrame,
  MAX_CHASSIS_PORTS,
  nextDiagramSlot,
  nextSlotInGroup,
  occupiedBoxes,
  portHandleId,
  targetPortHandleId,
  RACK_SIZE,
  ROOM_SIZE,
}

export const RF_SNAP = [16, 16] as const
export const COLLAPSED_GROUP_SIZE = { width: 248, height: 88 }

export function lockedSceneIds(scene: NetworkMapScene): Set<string> {
  const ids = new Set<string>()
  for (const group of scene.groups) if (group.locked) ids.add(group.id)
  for (const node of scene.nodes) if (node.locked) ids.add(node.id)
  return ids
}

export function groupDisplaySize(group: NetworkMapGroup): { width: number; height: number } {
  if (group.collapsed) return { ...COLLAPSED_GROUP_SIZE }
  return { width: group.width, height: group.height }
}

export function worldPosition(
  node: { x: number; y: number; parentGroupId?: string | null },
  groups: NetworkMapGroup[],
): { x: number; y: number } {
  const group = node.parentGroupId ? groups.find((g) => g.id === node.parentGroupId) : undefined
  if (!group) return { x: node.x, y: node.y }
  const looksLocal = node.x >= 0 && node.y >= 0 && node.x <= group.width && node.y <= group.height
  const absInside =
    node.x >= group.x && node.y >= group.y && node.x <= group.x + group.width && node.y <= group.y + group.height
  if (looksLocal && !absInside) {
    return { x: group.x + node.x, y: group.y + node.y }
  }
  return { x: node.x, y: node.y }
}

export function flattenSubnetGroups(scene: NetworkMapScene): NetworkMapScene {
  const subnetIds = new Set(scene.groups.filter((g) => g.kind === 'subnet').map((g) => g.id))
  if (!subnetIds.size) return scene
  return {
    ...scene,
    groups: scene.groups.filter((g) => g.kind !== 'subnet'),
    nodes: scene.nodes.map((n) =>
      n.parentGroupId && subnetIds.has(n.parentGroupId) ? { ...n, parentGroupId: null } : n,
    ),
  }
}

export function toWorldScene(scene: NetworkMapScene): NetworkMapScene {
  let changed = false
  const nodes = scene.nodes.map((n) => {
    const pos = worldPosition(n, scene.groups)
    if (pos.x === n.x && pos.y === n.y) return n
    changed = true
    return { ...n, x: pos.x, y: pos.y }
  })
  const world = changed ? { ...scene, nodes } : scene
  return flattenSubnetGroups(world)
}

export function groupContainsNode(
  group: NetworkMapGroup,
  node: {
    x: number
    y: number
    stencil?: string
    label?: string | null
    width?: number | null
    height?: number | null
    portCount?: number | null
  },
): boolean {
  const box = groupDisplaySize(group)
  const w = equipmentWidth(node.stencil || 'unknown', node.label || '', node.width, node.portCount)
  const h = equipmentHeight(node.stencil || 'unknown', node.label || '', node.height, node.portCount)
  const cx = node.x + w / 2
  const cy = node.y + h / 2
  return cx >= group.x && cy >= group.y && cx <= group.x + box.width && cy <= group.y + box.height
}

export function releaseNodeFromGroup(scene: NetworkMapScene, nodeId: string): NetworkMapScene {
  const node = scene.nodes.find((n) => n.id === nodeId)
  if (!node?.parentGroupId) return scene
  const group = scene.groups.find((g) => g.id === node.parentGroupId)
  if (group && groupContainsNode(group, node)) return scene
  return {
    ...scene,
    nodes: scene.nodes.map((n) => (n.id === nodeId ? { ...n, parentGroupId: null } : n)),
  }
}

function portNameFromHandle(node: Node | undefined, handle: string | null | undefined): string | null {
  if (!handle) return null
  const raw = handle.replace(/-(src|tgt)$/, '')
  const ports = (node?.data as EquipmentNodeData | undefined)?.ports
  const hit = ports?.find((p) => p.id === raw || p.id === handle || portHandleId(p.name) === raw)
  if (hit?.name) return hit.name
  if (raw.startsWith('p:')) return raw.slice(2).replace(/-/g, '/')
  return null
}

export function viewportFlowCenter(
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const zoom = viewport.zoom || 1
  return {
    x: (-viewport.x + size.width / 2) / zoom,
    y: (-viewport.y + size.height / 2) / zoom,
  }
}

export function toFlowNodes(
  groups: NetworkMapGroup[],
  nodes: MergedCanvasNode[],
): Node<EquipmentNodeData | GroupNodeData>[] {
  const counts = new Map<string, number>()
  for (const n of nodes) {
    if (!n.parentGroupId) continue
    counts.set(n.parentGroupId, (counts.get(n.parentGroupId) || 0) + 1)
  }
  const out: Node<EquipmentNodeData | GroupNodeData>[] = groups
    .filter((g) => g.kind !== 'subnet')
    .map((g) => {
    const size = groupDisplaySize(g)
    return {
      id: g.id,
      type: 'groupFrame',
      position: { x: g.x, y: g.y },
      data: {
        title: g.title,
        kind: g.kind,
        collapsed: Boolean(g.collapsed),
        cidr: g.cidr || null,
        count: counts.get(g.id) || 0,
        locked: Boolean(g.locked),
      },
      style: {
        width: size.width,
        height: size.height,
        background: 'transparent',
        border: 'none',
        padding: 0,
        overflow: 'visible',
      },
      zIndex: 0,
      draggable: !g.locked,
      selectable: true,
      className: g.locked ? 'is-locked' : undefined,
    }
  })
  const collapsed = new Set(groups.filter((g) => g.collapsed).map((g) => g.id))
  for (const n of nodes) {
    const parent = n.parentGroupId && groups.some((g) => g.id === n.parentGroupId) ? n.parentGroupId : undefined
    const pos = worldPosition(n, groups)
    out.push({
      id: n.id,
      type: 'equipment',
      position: { x: pos.x, y: pos.y },
      hidden: Boolean(parent && collapsed.has(parent)),
      data: {
        stencil: n.stencil,
        title: n.label,
        subtitle: n.ip || undefined,
        status: n.status,
        missing: n.missing,
        bind: n.bind ?? null,
        kind: n.kind,
        imageSrc: n.imageSrc ?? null,
        width: n.width ?? undefined,
        height: n.height ?? undefined,
        ports: n.ports,
        portCount: n.portCount ?? n.ports?.length,
        parentGroupId: parent || null,
        locked: Boolean(n.locked),
      },
      style: {
        width: equipmentWidth(n.stencil, n.label, n.width, n.portCount ?? n.ports?.length),
        height: equipmentHeight(n.stencil, n.label, n.height, n.portCount ?? n.ports?.length),
        padding: 0,
        border: 'none',
        background: 'transparent',
        boxShadow: 'none',
      },
      zIndex: n.stencil === 'image' ? 0 : n.stencil === 'note' ? 2 : 1,
      draggable: !n.locked,
      className: n.locked ? 'is-locked' : undefined,
      connectable: n.stencil !== 'note' && n.stencil !== 'image',
    })
  }
  return out
}

export function cableJunctions(
  sourceParent: string | null | undefined,
  targetParent: string | null | undefined,
  groups: NetworkMapGroup[],
): { x: number; y: number }[] {
  const frame = (id: string | null | undefined) => {
    if (!id) return null
    const group = groups.find((item) => item.id === id)
    if (!group || group.collapsed || (group.kind !== 'room' && group.kind !== 'rack')) return null
    return group
  }
  const point = (group: NetworkMapGroup) => {
    const size = groupDisplaySize(group)
    return { x: Math.round(group.x + size.width - 18), y: Math.round(group.y + size.height / 2) }
  }
  const source = frame(sourceParent)
  const target = frame(targetParent)
  if (source && target && source.id === target.id) return [point(source)]
  const out: { x: number; y: number }[] = []
  if (source) out.push(point(source))
  if (target) out.push(point(target))
  return out
}

export function magnetEquipmentPosition(
  scene: NetworkMapScene,
  node: {
    id: string
    stencil: string
    x: number
    y: number
    width?: number | null
    height?: number | null
    label?: string | null
    portCount?: number | null
  },
): { x: number; y: number } | null {
  if (node.stencil === 'note' || node.stencil === 'image') return null
  const width = equipmentWidth(node.stencil, node.label || '', node.width, node.portCount)
  const height = equipmentHeight(node.stencil, node.label || '', node.height, node.portCount)
  const frame = scene.groups.find(
    (group) =>
      (group.kind === 'room' || group.kind === 'rack') &&
      !group.collapsed &&
      groupContainsNode(group, { ...node, width, height }),
  )
  if (!frame || (frame.kind !== 'room' && frame.kind !== 'rack')) return null
  const siblings = scene.nodes
    .filter((other) => other.id !== node.id && other.stencil !== 'note' && other.stencil !== 'image')
    .filter((other) => groupContainsNode(frame, other))
    .map((other) => ({
      x: other.x,
      y: other.y,
      width: equipmentWidth(other.stencil, other.label || '', other.width, other.portCount),
      height: equipmentHeight(other.stencil, other.label || '', other.height, other.portCount),
    }))
  const next = magnetInFrame(
    { x: node.x, y: node.y },
    { width, height },
    { x: frame.x, y: frame.y, width: frame.width, height: frame.height, kind: frame.kind },
    siblings,
  )
  if (next.x === node.x && next.y === node.y) return null
  return next
}

function isLinkDown(status: string | undefined): boolean {
  const value = String(status || '').toLowerCase()
  return value === 'down' || value === 'error' || value === 'offline'
}

export function toFlowEdges(
  edges: MergedCanvasEdge[],
  groups: NetworkMapGroup[] = [],
  nodes: MergedCanvasNode[] = [],
): Edge[] {
  const collapsed = new Set(groups.filter((g) => g.collapsed).map((g) => g.id))
  const parentOf = new Map(nodes.map((n) => [n.id, n.parentGroupId || '']))
  const rewrite = (id: string) => {
    const parent = parentOf.get(id)
    return parent && collapsed.has(parent) ? parent : id
  }
  const lanes = laneForEdges(edges)
  const statusById = new Map(nodes.map((n) => [n.id, String(n.status || '').toLowerCase()]))
  return edges.flatMap((e) => {
    const source = rewrite(e.source)
    const target = rewrite(e.target)
    if (!source || !target || source === target) return []
    const manual = e.linkType === 'manual'
    const lan = e.linkType === 'lan'
    const traced = e.linkType === 'trace'
    const subnet = e.linkType === 'subnet'
    const lldp =
      e.linkType === 'lldp' ||
      e.linkType === 'cdp' ||
      e.linkType === 'mndp' ||
      e.linkType === 'ndp' ||
      e.linkType === 'fdp' ||
      e.linkType === 'edp' ||
      e.linkType === 'isdp' ||
      e.linkType === 'hndp'
    const fdb = e.linkType === 'fdb'
    const caption = [e.localPort, e.remotePort].filter(Boolean).join(' → ')
    const junctions =
      e.points?.length || source !== e.source || target !== e.target
        ? []
        : cableJunctions(parentOf.get(e.source), parentOf.get(e.target), groups)
    const srcDown = isLinkDown(statusById.get(e.source))
    const tgtDown = isLinkDown(statusById.get(e.target))
    const signal = !lan && !subnet && !srcDown && !tgtDown && (lldp || fdb || traced || manual)
    return [
      {
        id: e.id,
        source,
        target,
        sourceHandle: portHandleId(e.localPort) || undefined,
        targetHandle: targetPortHandleId(e.remotePort),
        type: 'cable',
        data: {
          linkDbId: e.linkDbId,
          persisted: e.persisted,
          linkType: e.linkType,
          lane: lanes.get(e.id) || 0,
          signal,
          points: e.points || [],
          junctions,
        },
        label: caption || undefined,
        selectable: true,
        focusable: true,
        interactionWidth: 28,
        animated: false,
        zIndex: traced ? 4 : manual ? 3 : 2,
        style: {
          stroke: cableStrokeColor(e.linkType),
          strokeWidth: traced || manual ? 2.35 : lldp ? 2.1 : 1.9,
          strokeDasharray: lan || subnet ? '5 4' : undefined,
          opacity: 1,
        },
      },
    ]
  })
}

function portsKey(ports: string[] | undefined): string {
  return ports?.length ? ports.join('\0') : ''
}

export function portsForPicker(
  ports?: Array<{ id: string; name: string; up?: boolean | null }> | null,
  limit = 24,
): Array<{ id: string; name: string; up?: boolean | null }> {
  const seen = new Set<string>()
  const out: Array<{ id: string; name: string; up?: boolean | null }> = []
  for (const port of ports || []) {
    const name = (port.name || '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ id: port.id || name, name, up: port.up })
    if (out.length >= limit) break
  }
  return out
}

export function isMultiSelectEvent(event: {
  shiftKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
} | null | undefined): boolean {
  return Boolean(event?.shiftKey || event?.ctrlKey || event?.metaKey)
}

export function nextCanvasPackIds(prev: string[], id: string, additive: boolean): string[] {
  if (!additive) return [id]
  return prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
}

export function followPackLeader(
  members: Array<{ id: string; x: number; y: number }>,
  origin: { x: number; y: number },
  leader: { id: string; x: number; y: number },
): Array<{ id: string; x: number; y: number }> {
  const dx = leader.x - origin.x
  const dy = leader.y - origin.y
  return members.map((m) =>
    m.id === leader.id ? { id: m.id, x: leader.x, y: leader.y } : { id: m.id, x: m.x + dx, y: m.y + dy },
  )
}

export function addToCanvasPack(prev: string[], id: string): string[] {
  return prev.includes(id) ? prev : [...prev, id]
}

export function decorateSelection(
  rfNodes: Node[],
  rfEdges: Edge[],
  selectedIds: string[] | string | null,
  selectedGroupId: string | string[] | null = null,
  selectedEdgeId: string | null = null,
): { nodes: Node[]; edges: Edge[] } {
  const ids = Array.isArray(selectedIds) ? selectedIds : selectedIds ? [selectedIds] : []
  const selectedSet = new Set(ids)
  const groupIds = new Set(
    Array.isArray(selectedGroupId) ? selectedGroupId : selectedGroupId ? [selectedGroupId] : [],
  )
  const primary = ids.length === 1 ? ids[0] : null
  const cable = !primary && selectedEdgeId ? rfEdges.find((e) => e.id === selectedEdgeId) : undefined
  const related = new Set<string>()
  const hotByNode = new Map<string, Set<string>>()
  const addHot = (nodeId: string, handle?: string | null) => {
    if (!handle) return
    const set = hotByNode.get(nodeId) ?? new Set<string>()
    set.add(handle)
    hotByNode.set(nodeId, set)
  }
  if (primary) {
    related.add(primary)
    for (const e of rfEdges) {
      if (e.source !== primary && e.target !== primary) continue
      related.add(e.source)
      related.add(e.target)
      addHot(e.source, e.sourceHandle)
      addHot(e.target, e.targetHandle)
    }
  } else if (cable) {
    related.add(cable.source)
    related.add(cable.target)
    addHot(cable.source, cable.sourceHandle)
    addHot(cable.target, cable.targetHandle)
  }

  const nodes = rfNodes.map((n) => {
    const isSelected = selectedSet.has(n.id) || groupIds.has(n.id)
    const data = n.data as EquipmentNodeData | undefined
    const locked = Boolean((n.data as { locked?: boolean } | undefined)?.locked)
    if (n.type !== 'equipment') {
      const className = [isSelected ? 'is-pack-selected' : '', locked ? 'is-locked' : ''].filter(Boolean).join(' ') || undefined
      if (n.selected === isSelected && n.className === className) return n
      return { ...n, selected: isSelected, className }
    }
    const neighbor = related.has(n.id) && !isSelected
    const hotPorts = [...(hotByNode.get(n.id) ?? [])]
    const className = [isSelected ? 'is-pack-selected' : '', neighbor ? 'is-neighbor' : '', locked ? 'is-locked' : ''].filter(Boolean).join(' ') || undefined
    const same =
      n.selected === isSelected &&
      n.className === className &&
      data?.neighbor === neighbor &&
      data?.selected === isSelected &&
      portsKey(data?.hotPorts) === portsKey(hotPorts)
    if (same) return n
    return {
      ...n,
      selected: isSelected,
      className,
      data: {
        ...data,
        neighbor,
        hotPorts,
        selected: isSelected,
      },
    }
  })

  if (!primary && !cable) {
    return { nodes, edges: rfEdges }
  }

  return {
    nodes,
    edges: rfEdges.map((e) => {
      const on = cable ? e.id === cable.id : e.source === primary || e.target === primary
      return {
        ...e,
        selected: cable ? e.id === cable.id : Boolean(e.selected),
        data: {
          ...(e.data as Record<string, unknown> | undefined),
          highlight: on ? 'related' : 'dim',
        },
        className: on ? (cable ? 'is-related is-cable-selected' : 'is-related') : 'is-dim',
        animated: false,
        zIndex: on ? 8 : 1,
        style: {
          ...e.style,
          stroke: on ? CABLE_STROKE : cableStrokeColor((e.data as { linkType?: string } | undefined)?.linkType, e.style?.stroke),
          strokeWidth: on ? 2.8 : Number(e.style?.strokeWidth || 2.1),
          opacity: on ? 1 : 0.42,
        },
      }
    }),
  }
}

export function decorateFocus(
  rfNodes: Node[],
  rfEdges: Edge[],
  canvas: MergedCanvasNode[],
  query: string,
  cidr: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const q = query.trim()
  if (!q && !cidr) return { nodes: rfNodes, edges: rfEdges }
  const hit = new Set(
    canvas
      .filter((n) => {
        if (q && !matchMapQuery(n, q)) return false
        if (cidr && ipv4Slash24(n.ip) !== cidr) return false
        return true
      })
      .map((n) => n.id),
  )
  return {
    nodes: rfNodes.map((n) => {
      if (n.type !== 'equipment') return n
      const on = hit.has(n.id)
      return {
        ...n,
        style: { ...n.style, opacity: on ? 1 : 0.2 },
        className: [n.className, on ? 'is-focus' : 'is-layer-dim'].filter(Boolean).join(' '),
      }
    }),
    edges: rfEdges.map((e) => {
      const on = hit.has(e.source) || hit.has(e.target)
      return { ...e, style: { ...e.style, opacity: on ? 1 : 0.1 } }
    }),
  }
}

export function collectScene(
  rfNodes: Node[],
  rfEdges: Edge[],
  previous: NetworkMapScene,
  viewport: NetworkMapScene['viewport'],
): NetworkMapScene {
  const prevGroup = new Map(previous.groups.map((g) => [g.id, g]))
  const prevNode = new Map(previous.nodes.map((n) => [n.id, n]))
  const groups: NetworkMapGroup[] = []
  const nodes: NetworkMapScene['nodes'] = []
  const seenNodes = new Set<string>()
  for (const n of rfNodes) {
    if (n.type !== 'groupFrame') continue
    const data = n.data as GroupNodeData
    const prev = prevGroup.get(n.id)
    const collapsed = Boolean(data.collapsed ?? prev?.collapsed)
    groups.push({
      id: n.id,
      title: data.title,
      kind: data.kind,
      x: n.position.x,
      y: n.position.y,
      width: collapsed && prev ? prev.width : Number(n.width || n.style?.width || 420),
      height: collapsed && prev ? prev.height : Number(n.height || n.style?.height || 280),
      collapsed: collapsed || undefined,
      cidr: data.cidr ?? prev?.cidr ?? null,
      locked: (data.locked != null ? Boolean(data.locked) : Boolean(prev?.locked)) || undefined,
    })
  }
  const groupIds = new Set(groups.map((g) => g.id))
  for (const n of rfNodes) {
    if (n.type !== 'equipment') continue
    const data = n.data as EquipmentNodeData
    seenNodes.add(n.id)
    const membership = data.parentGroupId ?? prevNode.get(n.id)?.parentGroupId ?? null
    nodes.push({
      id: n.id,
      stencil: data.stencil,
      x: n.position.x,
      y: n.position.y,
      parentGroupId: membership && groupIds.has(membership) ? membership : null,
      bind: data.bind ?? null,
      label: data.title,
      imageSrc: data.imageSrc ?? null,
      width: data.width ?? (typeof n.width === 'number' ? n.width : null),
      height: data.height ?? (typeof n.height === 'number' ? n.height : null),
      portCount: typeof data.portCount === 'number' && data.portCount > 0 ? data.portCount : prevNode.get(n.id)?.portCount ?? null,
      locked: (data.locked != null ? Boolean(data.locked) : Boolean(prevNode.get(n.id)?.locked)) || undefined,
    })
  }
  for (const node of previous.nodes) {
    if (seenNodes.has(node.id)) continue
    const parent = node.parentGroupId
    if (parent && groups.some((g) => g.id === parent && g.collapsed)) {
      nodes.push(node)
      seenNodes.add(node.id)
    }
  }
  const byId = new Map(rfNodes.map((n) => [n.id, n]))
  const collapsedIds = new Set(groups.filter((g) => g.collapsed).map((g) => g.id))
  const rfEdgeIds = new Set(rfEdges.map((e) => e.id))
  const edges = new Map<string, NetworkMapScene['edges'][number]>()
  const hiddenInCollapsed = (nodeId: string) => {
    if (collapsedIds.has(nodeId)) return true
    const parent = prevNode.get(nodeId)?.parentGroupId
    return Boolean(parent && collapsedIds.has(parent))
  }
  for (const edge of previous.edges) {
    if (!rfEdgeIds.has(edge.id)) continue
    if (hiddenInCollapsed(edge.source) || hiddenInCollapsed(edge.target)) {
      edges.set(edge.id, edge)
    }
  }
  for (const e of rfEdges) {
    if (!e.source || !e.target || e.source === e.target) continue
    if (collapsedIds.has(e.source) || collapsedIds.has(e.target)) continue
    const prev = previous.edges.find((x) => x.id === e.id)
    edges.set(e.id, {
      id: e.id,
      source: e.source,
      target: e.target,
      local_port: portNameFromHandle(byId.get(e.source), e.sourceHandle) || prev?.local_port || null,
      remote_port: portNameFromHandle(byId.get(e.target), e.targetHandle) || prev?.remote_port || null,
      link_type: String((e.data as { linkType?: string } | undefined)?.linkType || prev?.link_type || 'manual'),
      points: sanitizeCablePoints((e.data as { points?: unknown } | undefined)?.points ?? prev?.points),
    })
  }
  return {
    version: 1,
    groups,
    nodes,
    edges: [...edges.values()],
    hiddenNodeIds: previous.hiddenNodeIds,
    viewport,
  }
}

export function groupAtPoint(
  rfNodes: Node[],
  pos: { x: number; y: number },
  size?: { width: number; height: number },
): Node | null {
  const groups = rfNodes.filter((n) => n.type === 'groupFrame')
  for (const g of groups) {
    const w = Number(g.width || g.style?.width || 0)
    const h = Number(g.height || g.style?.height || 0)
    if (pos.x < g.position.x || pos.y < g.position.y) continue
    if (pos.x > g.position.x + w || pos.y > g.position.y + h) continue
    if (size) {
      if (pos.x + size.width > g.position.x + w - 8) continue
      if (pos.y + size.height > g.position.y + h - 8) continue
    }
    return g
  }
  return null
}

export function applyFrameMembership(scene: NetworkMapScene, nodeId: string, rfNodes: Node[]): NetworkMapScene {
  const node = scene.nodes.find((n) => n.id === nodeId)
  if (!node) return scene
  const w = equipmentWidth(node.stencil, node.label || '', node.width, node.portCount)
  const h = equipmentHeight(node.stencil, node.label || '', node.height, node.portCount)
  const hit = groupAtPoint(rfNodes, { x: node.x + w / 2, y: node.y + h / 2 })
  const kind = (hit?.data as GroupNodeData | undefined)?.kind
  const gid = hit && (kind === 'room' || kind === 'rack') ? hit.id : null
  if ((node.parentGroupId || null) === gid) return scene
  return {
    ...scene,
    nodes: scene.nodes.map((n) => (n.id === nodeId ? { ...n, parentGroupId: gid } : n)),
  }
}

/** Nest a dropped node into the room/rack under its centre — no extra drag. */
export function applySceneFrameMembership(scene: NetworkMapScene, nodeId: string): NetworkMapScene {
  const node = scene.nodes.find((n) => n.id === nodeId)
  if (!node) return scene
  const hit = scene.groups.find((g) => {
    if (g.kind !== 'room' && g.kind !== 'rack') return false
    if (g.collapsed) return false
    return groupContainsNode(g, node)
  })
  const gid = hit?.id ?? null
  if ((node.parentGroupId || null) === gid) return scene
  return {
    ...scene,
    nodes: scene.nodes.map((n) => (n.id === nodeId ? { ...n, parentGroupId: gid } : n)),
  }
}
