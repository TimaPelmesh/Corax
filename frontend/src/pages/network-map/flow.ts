import { type Edge, type Node } from 'reactflow'
import { laneForEdges } from './cables'
import { ipv4Slash24, matchMapQuery } from './inventory'
import type { MergedCanvasEdge, MergedCanvasNode, NetworkMapGroup, NetworkMapScene } from './types'
import type { EquipmentNodeData, GroupNodeData } from './NetworkMapCanvasNode'

export const RF_SNAP = [16, 16] as const
export const COLLAPSED_GROUP_SIZE = { width: 248, height: 88 }

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
  node: { x: number; y: number; stencil?: string; label?: string | null; width?: number | null; height?: number | null },
): boolean {
  const box = groupDisplaySize(group)
  const w = equipmentWidth(node.stencil || 'unknown', node.label || '', node.width)
  const h = equipmentHeight(node.stencil || 'unknown', node.label || '', node.height)
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

export function portHandleId(name: string | null | undefined): string | undefined {
  const raw = (name || '').trim()
  if (!raw) return undefined
  const slug = raw.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
  return slug ? `p:${slug}` : undefined
}

function portNameFromHandle(node: Node | undefined, handle: string | null | undefined): string | null {
  if (!handle) return null
  const ports = (node?.data as EquipmentNodeData | undefined)?.ports
  const hit = ports?.find((p) => p.id === handle)
  if (hit?.name) return hit.name
  if (handle.startsWith('p:')) return handle.slice(2).replace(/-/g, '/')
  return null
}

export function equipmentWidth(
  stencil: string,
  label = '',
  width?: number | null,
  portCount?: number | null,
): number {
  if (width && width > 0) return Math.max(80, Math.min(1600, width))
  if (stencil === 'note') {
    const longest = label.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
    return Math.max(96, Math.min(420, longest * 11 + 20))
  }
  if (stencil === 'image') return 220
  if (stencil === 'switch' && (portCount || 0) > 8) {
    return Math.min(460, Math.max(120, Number(portCount) * 8 + 36))
  }
  return 112
}

export function equipmentHeight(stencil: string, label = '', height?: number | null): number {
  if (height && height > 0) return Math.max(48, Math.min(1200, height))
  if (stencil === 'note') return Math.max(36, Math.min(240, label.split('\n').length * 28 + 8))
  if (stencil === 'image') return 140
  if (stencil === 'switch' && label.length > 18) return 96
  return 90
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
      draggable: true,
      selectable: true,
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
      },
      style: {
        width: equipmentWidth(n.stencil, n.label, n.width, n.portCount ?? n.ports?.length),
        height: equipmentHeight(n.stencil, n.label, n.height),
        padding: 0,
        border: 'none',
        background: 'transparent',
        boxShadow: 'none',
      },
      zIndex: n.stencil === 'image' ? 0 : n.stencil === 'note' ? 2 : 1,
      connectable: n.stencil !== 'note' && n.stencil !== 'image',
    })
  }
  return out
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
    const srcRewritten = source !== e.source
    const tgtRewritten = target !== e.target
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
    const srcDown = isLinkDown(statusById.get(e.source))
    const tgtDown = isLinkDown(statusById.get(e.target))
    const signal = !lan && !subnet && !srcDown && !tgtDown && (lldp || fdb || traced || manual)
    return [
      {
        id: e.id,
        source,
        target,
        sourceHandle: srcRewritten ? undefined : portHandleId(e.localPort),
        targetHandle: tgtRewritten ? undefined : portHandleId(e.remotePort),
        type: 'cable',
        data: {
          linkDbId: e.linkDbId,
          persisted: e.persisted,
          linkType: e.linkType,
          lane: lanes.get(e.id) || 0,
          signal,
        },
        label: caption || undefined,
        animated: false,
        zIndex: traced ? 4 : manual ? 3 : 2,
        style: {
          stroke: traced
            ? '#7c3aed'
            : manual
              ? 'var(--color-fg)'
              : lan || subnet
                ? 'var(--color-fg-muted)'
                : 'var(--color-primary)',
          strokeWidth: traced || manual ? 1.9 : lldp ? 1.7 : 1.45,
          strokeDasharray: lan || subnet ? '5 4' : undefined,
          opacity: lan || subnet ? 0.75 : 1,
        },
      },
    ]
  })
}

export function decorateSelection(
  rfNodes: Node[],
  rfEdges: Edge[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  if (!selectedId) {
    const dirty = rfNodes.some((n) => {
      const data = n.data as EquipmentNodeData | undefined
      return Boolean(data?.neighbor || data?.hotPorts?.length)
    })
    if (!dirty) return { nodes: rfNodes, edges: rfEdges }
    return {
      nodes: rfNodes.map((n) => {
        const data = n.data as EquipmentNodeData | undefined
        if (!data?.neighbor && !data?.hotPorts?.length) return n
        return { ...n, className: undefined, data: { ...data, neighbor: false, hotPorts: [] } }
      }),
      edges: rfEdges,
    }
  }
  const related = new Set<string>([selectedId])
  const hotByNode = new Map<string, Set<string>>()
  const addHot = (nodeId: string, handle?: string | null) => {
    if (!handle) return
    const set = hotByNode.get(nodeId) ?? new Set<string>()
    set.add(handle)
    hotByNode.set(nodeId, set)
  }
  for (const e of rfEdges) {
    if (e.source !== selectedId && e.target !== selectedId) continue
    related.add(e.source)
    related.add(e.target)
    addHot(e.source, e.sourceHandle)
    addHot(e.target, e.targetHandle)
  }
  const dirty = new Set(related)
  for (const n of rfNodes) {
    const data = n.data as EquipmentNodeData | undefined
    if (data?.neighbor || data?.hotPorts?.length) dirty.add(n.id)
  }
  return {
    nodes: rfNodes.map((n) => {
      if (n.type !== 'equipment' || !dirty.has(n.id)) return n
      const data = n.data as EquipmentNodeData
      const neighbor = related.has(n.id) && n.id !== selectedId
      return {
        ...n,
        className: neighbor ? 'is-neighbor' : undefined,
        data: {
          ...data,
          neighbor,
          hotPorts: [...(hotByNode.get(n.id) ?? [])],
        },
      }
    }),
    edges: rfEdges.map((e) => {
      const on = e.source === selectedId || e.target === selectedId
      return {
        ...e,
        data: {
          ...(e.data as Record<string, unknown> | undefined),
          highlight: on ? 'related' : 'dim',
        },
        className: on ? 'is-related' : 'is-dim',
        animated: false,
        zIndex: on ? 8 : 1,
        style: {
          ...e.style,
          stroke: on ? 'var(--color-primary)' : e.style?.stroke,
          strokeWidth: on ? 2.8 : 1.1,
          opacity: on ? 1 : 0.16,
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
  const edges = (previous.edges.length ? previous.edges : []).reduce(
    (acc, edge) => {
      acc.set(edge.id, edge)
      return acc
    },
    new Map<string, NetworkMapScene['edges'][number]>(),
  )
  for (const e of rfEdges) {
    if (!e.source || !e.target || e.source === e.target) continue
    if (collapsedIds.has(e.source) || collapsedIds.has(e.target)) continue
    edges.set(e.id, {
      id: e.id,
      source: e.source,
      target: e.target,
      local_port: portNameFromHandle(byId.get(e.source), e.sourceHandle) || null,
      remote_port: portNameFromHandle(byId.get(e.target), e.targetHandle) || null,
      link_type: String((e.data as { linkType?: string } | undefined)?.linkType || 'manual'),
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
  const w = equipmentWidth(node.stencil, node.label || '', node.width)
  const h = equipmentHeight(node.stencil, node.label || '', node.height)
  const hit = groupAtPoint(rfNodes, { x: node.x + w / 2, y: node.y + h / 2 })
  const kind = (hit?.data as GroupNodeData | undefined)?.kind
  const gid = hit && (kind === 'room' || kind === 'rack') ? hit.id : null
  if ((node.parentGroupId || null) === gid) return scene
  return {
    ...scene,
    nodes: scene.nodes.map((n) => (n.id === nodeId ? { ...n, parentGroupId: gid } : n)),
  }
}
