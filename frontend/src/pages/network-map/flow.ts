import { MarkerType, type Edge, type Node } from 'reactflow'
import type { MergedCanvasEdge, MergedCanvasNode, NetworkMapGroup, NetworkMapScene } from './types'
import type { EquipmentNodeData, GroupNodeData } from './NetworkMapCanvasNode'

export const RF_SNAP = [16, 16] as const

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
  if (stencil === 'note') {
    const longest = label.split('\n').reduce((max, line) => Math.max(max, line.length), 0)
    return Math.max(96, Math.min(420, longest * 11 + 20))
  }
  if (stencil === 'image') return Math.max(80, width || 220)
  if (stencil === 'switch' && (portCount || 0) > 8) {
    return Math.min(460, Math.max(176, Number(portCount) * 8 + 36))
  }
  return stencil === 'pc' || stencil === 'printer' ? 148 : 176
}

export function equipmentHeight(stencil: string, label = '', height?: number | null): number {
  if (stencil === 'note') return Math.max(36, Math.min(240, label.split('\n').length * 28 + 8))
  if (stencil === 'image') return Math.max(48, height || 140)
  return 72
}

export function toFlowNodes(
  groups: NetworkMapGroup[],
  nodes: MergedCanvasNode[],
): Node<EquipmentNodeData | GroupNodeData>[] {
  const out: Node<EquipmentNodeData | GroupNodeData>[] = groups.map((g) => ({
    id: g.id,
    type: 'groupFrame',
    position: { x: g.x, y: g.y },
    data: { title: g.title, kind: g.kind },
    style: {
      width: g.width,
      height: g.height,
      background: 'transparent',
      border: 'none',
      padding: 0,
    },
    zIndex: -1,
    draggable: true,
    selectable: true,
  }))
  for (const n of nodes) {
    const parent = n.parentGroupId && groups.some((g) => g.id === n.parentGroupId) ? n.parentGroupId : undefined
    out.push({
      id: n.id,
      type: 'equipment',
      position: { x: n.x, y: n.y },
      parentNode: parent,
      extent: parent ? 'parent' : undefined,
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
      },
      style: {
        width: equipmentWidth(n.stencil, n.label, n.width, n.portCount ?? n.ports?.length),
        height: n.stencil === 'image' || n.stencil === 'note' ? equipmentHeight(n.stencil, n.label, n.height) : undefined,
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

export function toFlowEdges(edges: MergedCanvasEdge[]): Edge[] {
  return edges.map((e) => {
    const manual = e.linkType === 'manual'
    const lan = e.linkType === 'lan'
    const traced = e.linkType === 'trace'
    const lldp = e.linkType === 'lldp' || e.linkType === 'cdp' || e.linkType === 'mndp' || e.linkType === 'ndp' || e.linkType === 'fdp' || e.linkType === 'edp' || e.linkType === 'isdp' || e.linkType === 'hndp'
    const caption = [e.localPort, e.remotePort].filter(Boolean).join(' → ')
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: portHandleId(e.localPort),
      targetHandle: portHandleId(e.remotePort),
      type: 'smoothstep',
      data: { linkDbId: e.linkDbId, persisted: e.persisted, linkType: e.linkType },
      label: caption || (manual ? ' ' : undefined),
      animated: lldp || traced,
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      zIndex: traced ? 4 : manual ? 3 : 2,
      style: {
        stroke: traced ? '#7c3aed' : manual ? 'var(--color-fg)' : lan ? 'var(--color-fg-muted)' : 'var(--color-primary)',
        strokeWidth: traced || manual ? 2 : 1.4,
        strokeDasharray: lan ? '5 4' : manual ? '2 0' : undefined,
        opacity: lan ? 0.7 : 1,
      },
    }
  })
}

export function decorateSelection(
  rfNodes: Node[],
  rfEdges: Edge[],
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  if (!selectedId) return { nodes: rfNodes, edges: rfEdges }
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
  return {
    nodes: rfNodes.map((n) => {
      if (n.type !== 'equipment') return n
      const data = n.data as EquipmentNodeData
      const neighbor = related.has(n.id) && n.id !== selectedId
      return {
        ...n,
        className: neighbor ? 'is-neighbor' : n.className,
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
        className: on ? 'is-related' : 'is-dim',
        animated: on,
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

export function collectScene(
  rfNodes: Node[],
  rfEdges: Edge[],
  hiddenNodeIds: string[],
  viewport: NetworkMapScene['viewport'],
): NetworkMapScene {
  const groups: NetworkMapGroup[] = []
  const nodes: NetworkMapScene['nodes'] = []
  for (const n of rfNodes) {
    if (n.type === 'groupFrame') {
      const data = n.data as GroupNodeData
      groups.push({
        id: n.id,
        title: data.title,
        kind: data.kind,
        x: n.position.x,
        y: n.position.y,
        width: Number(n.style?.width || 420),
        height: Number(n.style?.height || 280),
      })
      continue
    }
    if (n.type !== 'equipment') continue
    const data = n.data as EquipmentNodeData
    nodes.push({
      id: n.id,
      stencil: data.stencil,
      x: n.position.x,
      y: n.position.y,
      parentGroupId: n.parentNode || null,
      bind: data.bind ?? null,
      label: data.title,
      imageSrc: data.imageSrc ?? null,
      width: data.width ?? null,
      height: data.height ?? null,
    })
  }
  const byId = new Map(rfNodes.map((n) => [n.id, n]))
  const edges = rfEdges
    .filter((e) => e.source && e.target && e.source !== e.target)
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      local_port: portNameFromHandle(byId.get(e.source), e.sourceHandle) || null,
      remote_port: portNameFromHandle(byId.get(e.target), e.targetHandle) || null,
    }))
  return {
    version: 1,
    groups,
    nodes,
    edges,
    hiddenNodeIds,
    viewport,
  }
}

export function groupAtPoint(rfNodes: Node[], pos: { x: number; y: number }): Node | null {
  const groups = rfNodes.filter((n) => n.type === 'groupFrame')
  for (const g of groups) {
    const w = Number(g.style?.width || 0)
    const h = Number(g.style?.height || 0)
    if (pos.x >= g.position.x && pos.x <= g.position.x + w && pos.y >= g.position.y && pos.y <= g.position.y + h) {
      return g
    }
  }
  return null
}
