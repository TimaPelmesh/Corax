import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from 'reactflow'

type CableData = {
  linkType?: string
  lane?: number
  persisted?: boolean
  linkDbId?: number | null
  highlight?: 'related' | 'dim'
  signal?: boolean
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
}: EdgeProps<CableData>) {
  const related = data?.highlight === 'related'
  const dim = data?.highlight === 'dim'
  const lane = Number(data?.lane || 0)
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 12,
    offset: 12 + lane * 14,
  })
  const stroke = String(style?.stroke || 'var(--color-primary)')
  const width = Number(style?.strokeWidth || 1.6)
  const dash = style?.strokeDasharray ? String(style.strokeDasharray) : undefined
  const caption = typeof label === 'string' ? label.trim() : ''
  const signal = Boolean(data?.signal) && !dim
  const motionId = `nm-cable-${id.replace(/[^A-Za-z0-9_-]/g, '')}`

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
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
    </>
  )
}
