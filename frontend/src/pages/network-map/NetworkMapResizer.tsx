import { useReactFlow, useNodeId } from 'reactflow'

const RESIZED = 'corax-map-node-resized'

export function notifyMapNodeResized() {
  window.dispatchEvent(new Event(RESIZED))
}

export function onMapNodeResized(handler: () => void): () => void {
  window.addEventListener(RESIZED, handler)
  return () => window.removeEventListener(RESIZED, handler)
}

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
  const { setNodes } = useReactFlow()
  if (!visible || !id) return null
  return (
    <span
      className="network-map-resizer nodrag nopan"
      title="Размер"
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        const host = (event.currentTarget as HTMLElement).closest('.react-flow__node') as HTMLElement | null
        const startW = host?.offsetWidth || minWidth
        const startH = host?.offsetHeight || minHeight
        const originX = event.clientX
        const originY = event.clientY
        const move = (ev: PointerEvent) => {
          const width = Math.min(maxWidth, Math.max(minWidth, Math.round((startW + ev.clientX - originX) / 4) * 4))
          const height = Math.min(maxHeight, Math.max(minHeight, Math.round((startH + ev.clientY - originY) / 4) * 4))
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id
                ? {
                    ...n,
                    width,
                    height,
                    style: { ...n.style, width, height },
                    data: { ...n.data, width, height },
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
  )
}
