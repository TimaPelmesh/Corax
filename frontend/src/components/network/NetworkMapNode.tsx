import type { CSSProperties, ReactNode } from 'react'
import { Handle, Position, type NodeProps } from 'reactflow'
import {
  IconAccessPoint,
  IconFirewall,
  IconPcs,
  IconPrinter,
  IconRouter,
  IconSwitch,
  IconWarehouse,
} from '../icons'

export type NetworkMapNodeData = {
  label: string
  title: string
  subtitle?: string
  deviceType: string
  kind: string
  ip?: string | null
  vendor?: string | null
  status?: string | null
  clusterOf?: string
  count?: number
}

const HANDLE: CSSProperties = {
  width: 7,
  height: 7,
  opacity: 0,
  background: 'transparent',
  border: 'none',
}

function typeIcon(deviceType: string): ReactNode {
  const cls = 'h-4 w-4 shrink-0'
  switch (deviceType) {
    case 'router':
    case 'gateway':
    case 'modem':
      return <IconRouter className={cls} />
    case 'switch':
    case 'controller':
      return <IconSwitch className={cls} />
    case 'ap':
      return <IconAccessPoint className={cls} />
    case 'firewall':
      return <IconFirewall className={cls} />
    case 'printer':
      return <IconPrinter className={cls} />
    case 'nas':
    case 'server':
      return <IconWarehouse className={cls} />
    default:
      return <IconPcs className={cls} />
  }
}

function typeTone(deviceType: string): string {
  switch (deviceType) {
    case 'router':
    case 'gateway':
      return 'border-violet-400/70 bg-violet-500/10 text-violet-900 dark:text-violet-100'
    case 'firewall':
      return 'border-amber-400/70 bg-amber-500/10 text-amber-950 dark:text-amber-100'
    case 'switch':
    case 'controller':
      return 'border-sky-400/70 bg-sky-500/10 text-sky-950 dark:text-sky-100'
    case 'ap':
      return 'border-teal-400/70 bg-teal-500/10 text-teal-950 dark:text-teal-100'
    case 'server':
    case 'nas':
      return 'border-indigo-400/70 bg-indigo-500/10 text-indigo-950 dark:text-indigo-100'
    case 'printer':
      return 'border-rose-400/60 bg-rose-500/10 text-rose-950 dark:text-rose-100'
    case 'computer':
    case 'host':
      return 'border-[var(--color-border)] bg-[var(--color-bg-muted)] text-[var(--color-fg)]'
    default:
      return 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)]'
  }
}

function typeCaption(deviceType: string): string {
  switch (deviceType) {
    case 'router':
      return 'роутер'
    case 'gateway':
      return 'шлюз'
    case 'switch':
      return 'свитч'
    case 'ap':
      return 'AP'
    case 'firewall':
      return 'firewall'
    case 'computer':
    case 'host':
      return 'ПК'
    case 'printer':
      return 'принтер'
    case 'server':
      return 'сервер'
    case 'nas':
      return 'NAS'
    case 'controller':
      return 'контроллер'
    case 'modem':
      return 'модем'
    default:
      return deviceType || 'узел'
  }
}

export function NetworkMapNode({ data }: NodeProps<NetworkMapNodeData>) {
  if (data.clusterOf) {
    return (
      <div className="relative">
        <Handle type="target" position={Position.Top} style={HANDLE} />
        <div className="flex h-[52px] w-[168px] items-center justify-center rounded-full border-2 border-[var(--color-primary)] bg-[color-mix(in_srgb,var(--color-primary)_14%,var(--color-surface))] px-3 text-center text-xs font-semibold leading-tight">
          ПК · {data.count ?? 0}
          <span className="ml-1 font-normal text-[var(--color-fg-subtle)]">раскрыть</span>
        </div>
        <Handle type="source" position={Position.Bottom} style={HANDLE} />
      </div>
    )
  }

  const compact = data.kind === 'computer' || data.kind === 'printer' || data.deviceType === 'host'
  const statusDot =
    data.status === 'ok' || data.status === 'online'
      ? 'bg-emerald-500'
      : data.status === 'error' || data.status === 'offline'
        ? 'bg-red-500'
        : 'bg-[var(--color-fg-subtle)]'

  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} style={HANDLE} />
      <div
        className={`flex items-start gap-2 rounded-xl border px-2.5 py-2 shadow-[0_4px_14px_rgb(0_0_0_/_0.06)] ${typeTone(data.deviceType)} ${
          compact ? 'w-[148px]' : 'w-[188px]'
        }`}
      >
        <span className="mt-0.5 text-current">{typeIcon(data.deviceType)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDot}`} />
            <div className="truncate text-[11px] font-semibold leading-tight">{data.title}</div>
          </div>
          {data.ip ? (
            <div className="truncate font-mono text-[10px] leading-tight text-[var(--color-fg-muted)]">{data.ip}</div>
          ) : null}
          <div className="truncate text-[10px] leading-tight text-[var(--color-fg-subtle)]">
            {typeCaption(data.deviceType)}
            {data.vendor ? ` · ${data.vendor}` : ''}
          </div>
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={HANDLE} />
    </div>
  )
}
