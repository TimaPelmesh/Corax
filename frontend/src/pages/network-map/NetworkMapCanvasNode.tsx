import { Fragment, memo, useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import { useLocale } from '../../i18n/LocaleContext'
import {
  chassisPortLayout,
  chassisPorts,
  defaultStencilPortCount,
  GEAR_HEAD,
  PORT_CELL,
  PORT_PAD_X,
  PORT_PAD_Y,
  PORT_ROW,
  portHandleId,
} from './chassis'
import { NetworkMapGlyph } from './NetworkMapGlyph'
import type { NetworkMapGroupKind, NetworkMapStencil } from './types'
import { NetworkMapResizer } from './NetworkMapResizer'

function InlineLabel({
  title,
  className,
  canRename,
  onRename,
  multiline = false,
}: {
  title: string
  className: string
  canRename?: boolean
  onRename?: (next: string) => void
  multiline?: boolean
}) {
  const { t } = useLocale()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const ref = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) setDraft(title)
  }, [editing, title])

  useEffect(() => {
    if (!editing) return
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [editing])

  const commit = () => {
    const next = multiline ? draft : draft.trim()
    setEditing(false)
    if (!next) {
      setDraft(title)
      return
    }
    if (next !== title) onRename?.(next)
  }

  if (!editing) {
    return (
      <div
        className={className}
        title={canRename && onRename ? t('networkMap.renameHint') : undefined}
        onDoubleClick={(event) => {
          if (!canRename || !onRename) return
          event.stopPropagation()
          event.preventDefault()
          setEditing(true)
        }}
      >
        {title || '…'}
      </div>
    )
  }

  const shared = {
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
    onBlur: commit,
    onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onDoubleClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onPointerDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    onKeyDown: (event: { key: string; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void; stopPropagation: () => void }) => {
      event.stopPropagation()
      if (event.key === 'Escape') {
        setDraft(title)
        setEditing(false)
        return
      }
      if (event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        commit()
      }
    },
    className:
      'network-map-inline-rename nodrag nopan w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1 py-0.5 text-center text-[11px] font-semibold text-[var(--color-fg)] outline-none',
  }

  if (multiline) {
    return <textarea ref={(el) => { ref.current = el }} rows={3} {...shared} className={`${shared.className} resize-y text-left text-[13px]`} />
  }
  return <input ref={(el) => { ref.current = el }} {...shared} />
}

function PortStrip({
  ports,
  width,
  hotPorts,
}: {
  ports: Array<{ id: string; name: string; up?: boolean | null }>
  width: number
  hotPorts?: string[]
}) {
  const { t } = useLocale()
  const { cols } = chassisPortLayout(ports.length)
  if (!ports.length || cols <= 0) return null
  const inner = Math.max(PORT_CELL, width - PORT_PAD_X * 2)
  const cell = inner / cols
  const jackW = Math.max(8, Math.min(11, cell - 3))
  const hot = new Set((hotPorts || []).map((name) => name.toLowerCase()))
  return (
    <>
      {ports.map((port, index) => {
        const col = index % cols
        const row = Math.floor(index / cols)
        const left = PORT_PAD_X + col * cell + cell / 2
        const top = GEAR_HEAD + PORT_PAD_Y + row * PORT_ROW + 7
        const hid = portHandleId(port.name) || port.id
        const lit = port.up === true || hot.has(port.name.toLowerCase())
        return (
          <Fragment key={port.id}>
            <span
              className={`network-map-rj45 ${lit ? 'is-up' : port.up === false ? 'is-down' : ''}`}
              title={port.name}
              style={{ left, top, width: jackW }}
            />
            <Handle
              type="source"
              position={Position.Bottom}
              id={hid}
              className="network-map-jack is-port nodrag nopan"
              style={{ left, top, transform: 'translate(-50%, -50%)' }}
              title={port.name || t('networkMap.connectCable')}
              isConnectable
            />
            <Handle
              type="target"
              position={Position.Top}
              id={`${hid}-tgt`}
              className="network-map-jack is-port nodrag nopan"
              style={{ left, top, transform: 'translate(-50%, -50%)' }}
              title={port.name || t('networkMap.connectCable')}
              isConnectable
            />
          </Fragment>
        )
      })}
    </>
  )
}

export type EquipmentNodeData = {
  stencil: NetworkMapStencil
  title: string
  subtitle?: string
  status?: string | null
  missing?: boolean
  selected?: boolean
  bind?: import('./types').NetworkMapBind | null
  kind?: string
  imageSrc?: string | null
  width?: number
  height?: number
  ports?: Array<{ id: string; name: string; up?: boolean | null }>
  portCount?: number
  hotPorts?: string[]
  neighbor?: boolean
  parentGroupId?: string | null
  canRename?: boolean
  onRename?: (next: string) => void
}

export type GroupNodeData = {
  title: string
  kind: NetworkMapGroupKind
  collapsed?: boolean
  cidr?: string | null
  count?: number
  gatewayLabel?: string | null
  canRename?: boolean
  onRename?: (next: string) => void
}

export const NetworkMapEquipmentNode = memo(function NetworkMapEquipmentNode({
  data,
  selected,
}: NodeProps<EquipmentNodeData>) {
  const picked = Boolean(selected || data.selected)
  if (data.stencil === 'note') {
    return (
      <div className={`h-full min-w-[4.5rem] px-1 py-0.5 ${picked ? 'is-selected' : ''}`}>
        {picked ? <span className="network-map-selection-box" aria-hidden /> : null}
        <div className="whitespace-pre-wrap text-[18px] font-semibold leading-snug tracking-tight text-[var(--color-fg)]">
          <InlineLabel
            title={data.title || ''}
            className="whitespace-pre-wrap"
            canRename={data.canRename}
            onRename={data.onRename}
            multiline
          />
        </div>
        <NetworkMapResizer visible={picked} minWidth={96} minHeight={36} maxWidth={640} maxHeight={320} />
      </div>
    )
  }
  if (data.stencil === 'image') {
    const w = data.width || 220
    const h = data.height || 140
    return (
      <div className={`relative h-full w-full overflow-visible ${picked ? 'is-selected' : ''}`} style={{ width: w, height: h }}>
        {picked ? <span className="network-map-selection-box" aria-hidden /> : null}
        <div className="h-full w-full overflow-hidden border border-[var(--color-border)] bg-[var(--color-bg-muted)]">
          {data.imageSrc ? (
            <img src={data.imageSrc} alt={data.title || ''} className="h-full w-full object-contain" draggable={false} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-[var(--color-fg-muted)]">{data.title}</div>
          )}
        </div>
        <NetworkMapResizer visible={picked} minWidth={80} minHeight={48} maxWidth={1600} maxHeight={1200} />
      </div>
    )
  }
  const down = data.status === 'error' || data.status === 'offline'
  const ports = (data.ports && data.ports.length > 0)
    ? data.ports
    : chassisPorts(null, data.portCount ?? defaultStencilPortCount(data.stencil) ?? 1)
  const nodeWidth = data.width || 108
  return (
    <div className={`network-map-gear relative h-full w-full ${picked ? 'is-selected' : ''}`}>
      {picked ? <span className="network-map-selection-box" aria-hidden /> : null}
      <PortStrip ports={ports} width={nodeWidth} hotPorts={data.hotPorts} />
      <div
        className={`flex w-full flex-col items-center justify-center gap-0 px-1 ${
          data.missing || down ? 'opacity-55' : ''
        } ${data.neighbor ? 'is-neighbor-node' : ''}`}
        style={{ height: GEAR_HEAD }}
      >
        <NetworkMapGlyph kind={data.stencil} size="md" active={picked} neighbor={data.neighbor} />
        <div className="network-map-caption min-w-0 max-w-full text-center">
          <InlineLabel
            title={data.title}
            className="truncate text-[11px] font-semibold leading-tight"
            canRename={data.canRename}
            onRename={data.onRename}
          />
          {data.subtitle ? (
            <div className="truncate font-mono text-[10px] leading-tight opacity-80">{data.subtitle}</div>
          ) : null}
        </div>
      </div>
      <NetworkMapResizer visible={picked} minWidth={108} minHeight={72} maxWidth={760} maxHeight={280} />
    </div>
  )
})

export const NetworkMapGroupNode = memo(function NetworkMapGroupNode({
  data,
  selected,
}: NodeProps<GroupNodeData>) {
  const collapsed = Boolean(data.collapsed)
  return (
    <div className="relative h-full w-full overflow-visible">
      <div className={`network-map-room-fill is-${data.kind} ${selected ? 'is-selected' : ''} absolute inset-0`} />
      <div className="network-map-group-chrome absolute left-2 top-1.5 max-w-[calc(100%-16px)] px-0.5 text-[11px] font-medium text-[var(--color-fg)]">
        <InlineLabel
          title={data.title}
          className="truncate"
          canRename={data.canRename}
          onRename={data.onRename}
        />
      </div>
      <NetworkMapResizer visible={Boolean(selected) && !collapsed} minWidth={160} minHeight={88} maxWidth={2400} maxHeight={1800} />
    </div>
  )
})
