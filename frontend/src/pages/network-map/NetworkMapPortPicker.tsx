import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n/LocaleContext'

export type MapPortOption = { id: string; name: string; up?: boolean | null }

type Props = {
  open: boolean
  sourceLabel: string
  targetLabel: string
  sourcePorts: MapPortOption[]
  targetPorts: MapPortOption[]
  initialLocal?: string | null
  initialRemote?: string | null
  confirmLabel?: string
  onClose: () => void
  onConfirm: (localPort: string | null, remotePort: string | null) => void
}

function PortList({
  label,
  ports,
  value,
  onChange,
  noneLabel,
}: {
  label: string
  ports: MapPortOption[]
  value: string
  onChange: (next: string) => void
  noneLabel: string
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="truncate text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
        {label}
      </div>
      <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-[var(--color-border)]">
        <button
          type="button"
          onClick={() => onChange('')}
          className={`block w-full px-2.5 py-1.5 text-left text-xs ${
            !value ? 'bg-[var(--color-bg-muted)] font-medium' : 'hover:bg-[var(--color-bg-muted)]'
          }`}
        >
          {noneLabel}
        </button>
        {ports.map((port) => (
          <button
            key={port.id || port.name}
            type="button"
            onClick={() => onChange(port.name)}
            className={`flex w-full items-center justify-between gap-2 border-t border-[var(--color-border)] px-2.5 py-1.5 text-left ${
              value === port.name ? 'bg-[var(--color-bg-muted)] font-medium' : 'hover:bg-[var(--color-bg-muted)]'
            }`}
          >
            <span className="truncate font-mono text-[11px]">{port.name}</span>
            {port.up === true ? <span className="text-[10px] text-emerald-600">up</span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}

export function NetworkMapPortPicker({
  open,
  sourceLabel,
  targetLabel,
  sourcePorts,
  targetPorts,
  initialLocal,
  initialRemote,
  confirmLabel,
  onClose,
  onConfirm,
}: Props) {
  const t = useT()
  const [localPort, setLocalPort] = useState(initialLocal || '')
  const [remotePort, setRemotePort] = useState(initialRemote || '')

  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[color-mix(in_srgb,var(--color-bg)_50%,black)] p-4"
      role="dialog"
      aria-modal
      aria-label={t('networkMap.portPickTitle')}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{t('networkMap.portPickTitle')}</h2>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t('networkMap.portPickHint')}</p>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <PortList
            label={t('networkMap.portPickFrom', { name: sourceLabel })}
            ports={sourcePorts}
            value={localPort}
            onChange={setLocalPort}
            noneLabel={t('networkMap.portPickNone')}
          />
          <PortList
            label={t('networkMap.portPickTo', { name: targetLabel })}
            ports={targetPorts}
            value={remotePort}
            onChange={setRemotePort}
            noneLabel={t('networkMap.portPickNone')}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(localPort || null, remotePort || null)}
            className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white"
          >
            {confirmLabel || t('networkMap.portPickConfirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
