import { useReactFlow, useNodeId } from 'reactflow'

const RESIZED = 'corax-map-node-resized'

export function notifyMapNodeResized() {
  window.dispatchEvent(new Event(RESIZED))
}

export function onMapNodeResized(handler: () => void): () => void {
  window.addEventListener(RESIZED, handler)
  return () => window.removeEventListener(RESIZED, handler)
}

export type ResizeCorner = 'nw' | 'ne' | 'sw' | 'se'

export function applyCornerResize(
  start: { x: number; y: number; width: number; height: number },
  flowDelta: { x: number; y: number },
  corner: ResizeCorner,
  minWidth: number,
  minHeight: number,
  maxWidth: number,
  maxHeight: number,
): { x: number; y: number; width: number; height: number } {
  let width = start.width
  let height = start.height
  if (corner === 'se' || corner === 'ne') width = start.width + flowDelta.x
  else width = start.width - flowDelta.x
  if (corner === 'se' || corner === 'sw') height = start.height + flowDelta.y
  else height = start.height - flowDelta.y
  width = Math.min(maxWidth, Math.max(minWidth, Math.round(width / 4) * 4))
  height = Math.min(maxHeight, Math.max(minHeight, Math.round(height / 4) * 4))
  return {
    x: corner === 'nw' || corner === 'sw' ? start.x + start.width - width : start.x,
    y: corner === 'nw' || corner === 'ne' ? start.y + start.height - height : start.y,
    width,
    height,
  }
}

const CORNERS: Array<{ id: ResizeCorner; className: string }> = [
  { id: 'nw', className: 'is-nw' },
  { id: 'ne', className: 'is-ne' },
  { id: 'sw', className: 'is-sw' },
  { id: 'se', className: 'is-se' },
]

type Props = {
  visible: boolean
  minWidth?: number
  minHeight?: number
  maxWidth?: number
  maxHeight?: number
}

export function NetworkMapResizer({
  visible,
  minWidth = 120,
  minHeight = 56,
  maxWidth = 1600,
  maxHeight = 1200,
}: Props) {
  const id = useNodeId()
  const { setNodes, getZoom, getNode } = useReactFlow()
  if (!visible || !id) return null
  return (
    <>
      {CORNERS.map((corner) => (
        <span
          key={corner.id}
          className={`network-map-resizer nodrag nopan ${corner.className}`}
          title="Размер"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const node = getNode(id)
            const host = (event.currentTarget as HTMLElement).closest('.react-flow__node') as HTMLElement | null
            const start = {
              x: node?.position.x ?? 0,
              y: node?.position.y ?? 0,
              width: Number(node?.width || node?.style?.width || host?.offsetWidth || minWidth),
              height: Number(node?.height || node?.style?.height || host?.offsetHeight || minHeight),
            }
            const originX = event.clientX
            const originY = event.clientY
            const zoom = Math.max(0.08, getZoom() || 1)
            const move = (ev: PointerEvent) => {
              const next = applyCornerResize(
                start,
                { x: (ev.clientX - originX) / zoom, y: (ev.clientY - originY) / zoom },
                corner.id,
                minWidth,
                minHeight,
                maxWidth,
                maxHeight,
              )
              setNodes((ns) =>
                ns.map((n) =>
                  n.id === id
                    ? {
                        ...n,
                        position: { x: next.x, y: next.y },
                        width: next.width,
                        height: next.height,
                        style: { ...n.style, width: next.width, height: next.height },
                        data: { ...n.data, width: next.width, height: next.height },
                      }
                    : n,
                ),
              )
            }
            const up = () => {
              window.removeEventListener('pointermove', move)
              window.removeEventListener('pointerup', up)
              notifyMapNodeResized()
            }
            window.addEventListener('pointermove', move)
            window.addEventListener('pointerup', up)
          }}
        />
      ))}
    </>
  )
}
