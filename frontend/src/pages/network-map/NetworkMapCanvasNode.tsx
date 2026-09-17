import { memo, type CSSProperties, type ReactNode } from 'react'
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
import type { NetworkMapGroupKind, NetworkMapStencil } from './types'
import { NetworkMapResizer } from './NetworkMapResizer'

const HANDLE: CSSProperties = {
  width: 8,
  height: 8,
  background: 'var(--color-primary)',
  border: '2px solid var(--color-surface)',
  opacity: 0.55,
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
}

export type GroupNodeData = {
  title: string
  kind: NetworkMapGroupKind
}

function stencilIcon(stencil: NetworkMapStencil): ReactNode {
  const cls = 'h-4 w-4'
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

function tone(stencil: NetworkMapStencil): string {
  switch (stencil) {
    case 'corax':
      return 'border-[var(--color-fg)] bg-[var(--color-fg)] text-[var(--color-surface)]'
    case 'router':
      return 'border-violet-400/70 bg-violet-500/10 text-violet-950 dark:text-violet-100'
    case 'firewall':
      return 'border-amber-400/70 bg-amber-500/10 text-amber-950 dark:text-amber-100'
    case 'switch':
      return 'border-sky-400/70 bg-sky-500/10 text-sky-950 dark:text-sky-100'
    case 'ap':
      return 'border-teal-400/70 bg-teal-500/10 text-teal-950 dark:text-teal-100'
    case 'server':
    case 'nas':
      return 'border-indigo-400/70 bg-indigo-500/10 text-indigo-950 dark:text-indigo-100'
    case 'printer':
      return 'border-rose-400/60 bg-rose-500/10 text-rose-950 dark:text-rose-100'
    case 'cloud':
      return 'border-cyan-400/60 bg-cyan-500/10 text-cyan-950 dark:text-cyan-100'
    case 'pc':
      return 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]'
    default:
      return 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]'
  }
}

function statusClass(status: string | null | undefined): string {
  if (status === 'ok' || status === 'online') return 'bg-emerald-500'
  if (status === 'error' || status === 'offline') return 'bg-red-500'
  return 'bg-[var(--color-fg-subtle)]'
}

function SwitchPorts({
  ports,
  selected,
  hotPorts,
}: {
  ports: Array<{ id: string; name: string; up?: boolean | null }>
  selected?: boolean
  hotPorts?: string[]
}) {
  const shown = ports.slice(0, 52)
  const hot = new Set(hotPorts || [])
  return (
    <div className="relative mt-1.5 flex flex-wrap gap-[3px]">
      {shown.map((port) => {
        const lit = selected || hot.has(port.id)
        return (
          <span key={port.id} className={`relative ${lit ? 'is-hot-port' : ''}`} title={port.name}>
            <Handle
              type="source"
              position={Position.Bottom}
              id={port.id}
              style={{
                ...HANDLE,
                position: 'relative',
                transform: 'none',
                left: 0,
                top: 0,
                width: 8,
                height: 10,
                borderRadius: 2,
                opacity: lit ? 1 : 0.85,
                background:
                  hot.has(port.id)
                    ? 'var(--color-primary)'
                    : port.up === true
                      ? 'rgb(16,185,129)'
                      : port.up === false
                        ? 'rgb(148,163,184)'
                        : 'var(--color-primary)',
              }}
            />
          </span>
        )
      })}
    </div>
  )
}

function PortRow({ compact, count }: { compact?: boolean; count?: number }) {
  const n = count && count > 0 ? Math.min(count, 24) : compact ? 4 : 8
  return (
    <div className="mt-1.5 flex gap-0.5">
      {Array.from({ length: n }, (_, i) => (
        <span
          key={i}
          className="h-1.5 flex-1 rounded-[1px] bg-current opacity-30"
        />
      ))}
    </div>
  )
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
        className={`relative h-full w-full overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_16px_36px_-24px_rgba(0,0,0,0.55)] ${
          selected ? 'ring-2 ring-[var(--color-primary)] ring-offset-1 ring-offset-[var(--color-bg)]' : ''
        }`}
        style={{ width: w, height: h }}
      >
        {data.imageSrc ? (
          <img src={data.imageSrc} alt={data.title || ''} className="h-full w-full object-contain" draggable={false} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-[var(--color-fg-subtle)]">{data.title}</div>
        )}
        <NetworkMapResizer visible={Boolean(selected)} minWidth={80} minHeight={48} maxWidth={1600} maxHeight={1200} />
      </div>
    )
  }
  const compact = data.stencil === 'pc' || data.stencil === 'printer'
  const livePorts = Boolean(selected || (data.hotPorts && data.hotPorts.length))
  return (
    <div className="relative h-full w-full">
      <Handle type="target" position={Position.Top} style={HANDLE} />
      <Handle type="target" position={Position.Left} id="left" style={HANDLE} />
      <div
        className={`h-full w-full rounded-lg border px-2.5 py-2 shadow-[0_10px_28px_-20px_rgba(0,0,0,0.65)] ${tone(data.stencil)} ${
          selected ? 'ring-2 ring-[var(--color-primary)] ring-offset-1 ring-offset-[var(--color-bg)]' : data.neighbor ? 'ring-2 ring-[var(--color-primary)]/45' : ''
        } ${data.missing ? 'opacity-70' : ''} ${compact ? 'min-w-[148px]' : 'min-w-[176px]'}`}
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-black/5 dark:bg-white/10">
            {stencilIcon(data.stencil)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass(data.status)}`} />
              <div className="truncate text-[11px] font-semibold leading-tight">{data.title}</div>
            </div>
            {data.subtitle ? (
              <div className="mt-0.5 truncate font-mono text-[10px] opacity-70">{data.subtitle}</div>
            ) : null}
          </div>
        </div>
        {data.stencil === 'switch' && (data.ports?.length || data.portCount) ? (
          livePorts && data.ports && data.ports.length > 0 ? (
            <SwitchPorts ports={data.ports} selected={selected} hotPorts={data.hotPorts} />
          ) : (
            <PortRow count={Math.min(data.portCount || data.ports?.length || 8, 24)} />
          )
        ) : data.stencil === 'server' || data.stencil === 'nas' ? (
          <PortRow compact />
        ) : null}
      </div>
      <Handle type="source" position={Position.Bottom} style={HANDLE} />
      <Handle type="source" position={Position.Right} id="right" style={HANDLE} />
      <NetworkMapResizer visible={Boolean(selected)} minWidth={compact ? 120 : 140} minHeight={56} maxWidth={640} maxHeight={280} />
    </div>
  )
})

export const NetworkMapGroupNode = memo(function NetworkMapGroupNode({
  data,
  selected,
}: NodeProps<GroupNodeData>) {
  return (
    <div className="relative h-full w-full rounded-3xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_78%,var(--color-primary)_8%)] shadow-[inset_0_1px_0_color-mix(in_srgb,white_18%,transparent)]">
      <div className="absolute inset-x-3 top-2 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--color-fg-muted)]">
          {data.title}
        </div>
      </div>
      <NetworkMapResizer visible={Boolean(selected)} minWidth={160} minHeight={120} maxWidth={2400} maxHeight={1800} />
    </div>
  )
})
