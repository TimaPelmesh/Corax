import { useRef, type MutableRefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, useReactFlow, type EdgeProps } from 'reactflow'
import { cableBendPath, sanitizeCablePoints, type CablePoint } from './cables'

type CableData = {
  linkType?: string
  lane?: number
  persisted?: boolean
  linkDbId?: number | null
  highlight?: 'related' | 'dim'
  signal?: boolean
  points?: CablePoint[]
  canEdit?: boolean
  persistRef?: MutableRefObject<() => void>
}

function knobStyle(x: number, y: number, size = 10): React.CSSProperties {
  return {
    transform: `translate(-50%, -50%) translate(${x}px,${y}px)`,
    width: size,
    height: size,
    pointerEvents: 'all',
  }
}

export function NetworkMapCableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  label,
  data,
  selected,
  interactionWidth = 28,
}: EdgeProps<CableData>) {
  const related = data?.highlight === 'related' || Boolean(selected)
  const dim = data?.highlight === 'dim' && !selected
  const lane = Number(data?.lane || 0)
  const points = sanitizeCablePoints(data?.points)
  const bent = points.length > 0
  const [autoPath, autoLabelX, autoLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
    offset: 12 + lane * 14,
  })
  const routed = bent
    ? cableBendPath([{ x: sourceX, y: sourceY }, ...points, { x: targetX, y: targetY }])
    : null
  const path = routed?.d || autoPath
  const labelX = routed?.labelX ?? autoLabelX
  const labelY = routed?.labelY ?? autoLabelY
  const stroke = String(style?.stroke || 'var(--color-primary)')
  const width = Number(style?.strokeWidth || 1.6)
  const dash = style?.strokeDasharray ? String(style.strokeDasharray) : undefined
  const caption = typeof label === 'string' ? label.trim() : ''
  const signal = Boolean(data?.signal) && !dim
  const motionId = `nm-cable-${id.replace(/[^A-Za-z0-9_-]/g, '')}`
  const canBend = Boolean(data?.canEdit && selected && !dim)
  const { setEdges, screenToFlowPosition } = useReactFlow()
  const dragIndex = useRef<number | null>(null)

  const writePoints = (next: CablePoint[]) => {
    const clean = sanitizeCablePoints(next)
    setEdges((eds) =>
      eds.map((edge) =>
        edge.id === id
          ? { ...edge, data: { ...(edge.data as CableData | undefined), points: clean } }
          : edge,
      ),
    )
  }

  const commit = () => {
    data?.persistRef?.current()
  }

  const onKnobDown = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    dragIndex.current = index
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onKnobMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragIndex.current === null) return
    event.stopPropagation()
    const pos = screenToFlowPosition({ x: event.clientX, y: event.clientY })
    writePoints(points.map((p, i) => (i === dragIndex.current ? pos : p)))
  }

  const onKnobUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragIndex.current === null) return
    event.stopPropagation()
    dragIndex.current = null
    commit()
  }

  const addAt = (point: CablePoint, at: number) => {
    if (points.length >= 8) return
    writePoints([...points.slice(0, at), point, ...points.slice(at)])
    commit()
  }

  const removeAt = (index: number) => {
    writePoints(points.filter((_, i) => i !== index))
    commit()
  }

  const vertices = [{ x: sourceX, y: sourceY }, ...points, { x: targetX, y: targetY }]

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        interactionWidth={interactionWidth}
        style={{
          ...style,
          fill: 'none',
          stroke,
          strokeWidth: related ? Math.max(width, 2.6) : width,
          strokeDasharray: dash,
          opacity: dim ? 0.16 : 1,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }}
      />
      {signal ? (
        <>
          <path
            d={path}
            fill="none"
            stroke={stroke}
            strokeWidth={related ? 2.2 : 1.7}
            className="network-map-signal-flow"
            style={{ opacity: 0.9 }}
          />
          <path id={motionId} d={path} fill="none" stroke="none" />
          <circle r={related ? 3.6 : 3.1} fill={stroke} className="network-map-signal">
            <animateMotion dur="1.8s" repeatCount="indefinite" rotate="auto">
              <mpath href={`#${motionId}`} />
            </animateMotion>
          </circle>
        </>
      ) : null}
      <circle cx={sourceX} cy={sourceY} r={related ? 3.2 : 2.2} fill={stroke} opacity={dim ? 0.2 : 1} />
      <circle cx={targetX} cy={targetY} r={related ? 3.2 : 2.2} fill={stroke} opacity={dim ? 0.2 : 1} />
      {caption && caption !== ' ' && !dim ? (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded px-1 py-px text-[9px] font-semibold leading-none tracking-wide"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              background: 'var(--color-surface)',
              color: related ? 'var(--color-primary)' : 'var(--color-fg-muted)',
              border: '1px solid var(--color-border)',
            }}
          >
            {caption}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {canBend ? (
        <EdgeLabelRenderer>
          {vertices.slice(0, -1).map((from, i) => {
            const to = vertices[i + 1]
            if (points.length >= 8) return null
            const mx = (from.x + to.x) / 2
            const my = (from.y + to.y) / 2
            return (
              <button
                key={`add-${i}`}
                type="button"
                title="+"
                className="network-map-bend is-add nodrag nopan absolute flex items-center justify-center rounded-full"
                style={knobStyle(mx, my, 12)}
                onClick={(event) => {
                  event.stopPropagation()
                  addAt({ x: mx, y: my }, i)
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                +
              </button>
            )
          })}
          {points.map((p, i) => (
            <button
              key={`knob-${i}`}
              type="button"
              className="network-map-bend is-knob nodrag nopan absolute rounded-full"
              style={knobStyle(p.x, p.y, 12)}
              onPointerDown={(event) => onKnobDown(i, event)}
              onPointerMove={onKnobMove}
              onPointerUp={onKnobUp}
              onPointerCancel={onKnobUp}
              onDoubleClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                removeAt(i)
              }}
            />
          ))}
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}
