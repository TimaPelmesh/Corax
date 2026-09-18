import { Fragment, memo, type CSSProperties, type ReactNode } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import {
  IconAccessPoint,
  IconCloud,
  IconFirewall,
  IconNetworkMap,
  IconPcs,
  IconPrinter,
  IconRouter,
  IconServer,
  IconSwitch,
  IconWarehouse,
} from '../../components/icons'
import { useLocale } from '../../i18n/LocaleContext'
import type { NetworkMapGroupKind, NetworkMapStencil } from './types'
import { NetworkMapResizer } from './NetworkMapResizer'

const JACK_SHIFT: Record<'top' | 'right' | 'bottom' | 'left', CSSProperties> = {
  top: { top: -8 },
  right: { right: -8 },
  bottom: { bottom: -8 },
  left: { left: -8 },
}

function CableJacks() {
  const { t } = useLocale()
  const title = t('networkMap.connectCable')
  const sides: Array<{ side: 'top' | 'right' | 'bottom' | 'left'; position: Position }> = [
    { side: 'top', position: Position.Top },
    { side: 'right', position: Position.Right },
    { side: 'bottom', position: Position.Bottom },
    { side: 'left', position: Position.Left },
  ]
  return (
    <>
      {sides.map(({ side, position }) => (
        <Fragment key={side}>
          <Handle
            type="source"
            position={position}
            id={side === 'right' || side === 'bottom' ? side : `${side}-src`}
            className="network-map-jack"
            style={JACK_SHIFT[side]}
            title={title}
            isConnectable
          />
          <Handle
            type="target"
            position={position}
            id={side === 'right' || side === 'bottom' ? `${side}-tgt` : side}
            className="network-map-jack"
            style={JACK_SHIFT[side]}
            title={title}
            isConnectable
          />
        </Fragment>
      ))}
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
}

export type GroupNodeData = {
  title: string
  kind: NetworkMapGroupKind
  collapsed?: boolean
  cidr?: string | null
  count?: number
  gatewayLabel?: string | null
}

function stencilIcon(stencil: NetworkMapStencil): ReactNode {
  const cls = 'h-5 w-5'
  switch (stencil) {
    case 'corax':
      return <IconNetworkMap className={cls} />
    case 'router':
      return <IconRouter className={cls} />
    case 'switch':
      return <IconSwitch className={cls} />
    case 'ap':
      return <IconAccessPoint className={cls} />
    case 'firewall':
      return <IconFirewall className={cls} />
    case 'server':
      return <IconServer className={cls} />
    case 'nas':
      return <IconWarehouse className={cls} />
    case 'printer':
      return <IconPrinter className={cls} />
    case 'cloud':
      return <IconCloud className={cls} />
    case 'pc':
      return <IconPcs className={cls} />
    default:
      return <IconPcs className={cls} />
  }
}

function statusClass(status: string | null | undefined): string {
  if (status === 'ok' || status === 'online') return 'text-emerald-700 dark:text-emerald-400'
  if (status === 'error' || status === 'offline') return 'text-red-600 dark:text-red-400'
  return 'text-[var(--color-fg-subtle)]'
}

export const NetworkMapEquipmentNode = memo(function NetworkMapEquipmentNode({
  data,
  selected,
}: NodeProps<EquipmentNodeData>) {
  if (data.stencil === 'note') {
    return (
      <div
        className={`h-full min-w-[4.5rem] px-1 py-0.5 ${
          selected ? 'rounded-md ring-2 ring-[var(--color-primary)] ring-offset-2 ring-offset-[var(--color-bg)]' : ''
        }`}
      >
        <div className="whitespace-pre-wrap text-[18px] font-semibold leading-snug tracking-tight text-[var(--color-fg)] [text-shadow:0_1px_0_color-mix(in_srgb,var(--color-surface)_80%,transparent)]">
          {data.title || '…'}
        </div>
        <NetworkMapResizer visible={Boolean(selected)} minWidth={96} minHeight={36} maxWidth={640} maxHeight={320} />
      </div>
    )
  }
  if (data.stencil === 'image') {
    const w = data.width || 220
    const h = data.height || 140
    return (
      <div
        className={`relative h-full w-full overflow-visible rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_16px_36px_-24px_rgba(0,0,0,0.55)] ${
          selected ? 'ring-2 ring-[var(--color-primary)] ring-offset-1 ring-offset-[var(--color-bg)]' : ''
        }`}
        style={{ width: w, height: h }}
      >
        <div className="h-full w-full overflow-hidden rounded-xl">
        {data.imageSrc ? (
          <img src={data.imageSrc} alt={data.title || ''} className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-[var(--color-fg-subtle)]">{data.title}</div>
        )}
        </div>
        <NetworkMapResizer visible={Boolean(selected)} minWidth={80} minHeight={48} maxWidth={1600} maxHeight={1200} />
      </div>
    )
  }
  const chassis = data.stencil === 'switch' && (data.portCount || 0) > 8
  return (
    <div className={`network-map-gear relative h-full w-full ${selected ? 'is-selected' : ''}`}>
      {selected ? <span className="network-map-selection-box" aria-hidden /> : null}
      <CableJacks />
      <div
        className={`flex h-full w-full flex-col items-center justify-center gap-1 px-1 ${
          data.missing ? 'opacity-70' : ''
        } ${data.neighbor ? 'is-neighbor-node' : ''}`}
      >
        <span
          className={`flex items-center justify-center rounded-lg border bg-[var(--color-surface)] text-[var(--color-fg)] ${
            chassis ? 'h-8 w-[calc(100%-8px)]' : 'h-9 w-9'
          } ${
            selected
              ? 'border-[var(--color-primary)]'
              : data.neighbor
                ? 'border-[var(--color-primary)]/55'
                : 'border-[var(--color-border)]'
          }`}
        >
          {stencilIcon(data.stencil)}
        </span>
        <div className="min-w-0 max-w-full text-center">
          <div className={`truncate text-[11px] font-semibold leading-tight ${statusClass(data.status)}`}>{data.title}</div>
          {data.subtitle ? (
            <div className="truncate font-mono text-[9px] leading-tight text-[var(--color-fg-muted)]">{data.subtitle}</div>
          ) : null}
        </div>
      </div>
      <NetworkMapResizer visible={Boolean(selected)} minWidth={chassis ? 140 : 88} minHeight={72} maxWidth={640} maxHeight={280} />
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
      <div
        className={`absolute inset-0 rounded-lg border border-dashed border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-fg)_3%,transparent)] ${
          selected ? 'border-solid border-[var(--color-primary)]' : ''
        }`}
      />
      <div className="network-map-group-chrome absolute left-1.5 top-1.5 max-w-[calc(100%-12px)] rounded-md bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
        {data.title}
      </div>
      <NetworkMapResizer visible={Boolean(selected) && !collapsed} minWidth={160} minHeight={88} maxWidth={2400} maxHeight={1800} />
    </div>
  )
})
