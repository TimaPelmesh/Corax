import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n/LocaleContext'

export type MapPortOption = { id: string; name: string; up?: boolean | null }

type Props = {
  open: boolean
  title: string
  hint: string
  ports: MapPortOption[]
  used: string[]
  x: number
  y: number
  onPick: (port: string | null) => void
  onClose: () => void
}

export function NetworkMapPortMenu({ open, title, hint, ports, used, x, y, onPick, onClose }: Props) {
  const t = useT()
  const busy = new Set(used)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const left = Math.max(8, Math.min(x, window.innerWidth - 228))
  const top = Math.max(8, Math.min(y, window.innerHeight - 320))
  return createPortal(
    <div className="fixed inset-0 z-[130]" onMouseDown={onClose} role="presentation">
      <div
        className="network-map-port-menu absolute w-[13.5rem] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
        style={{ left, top }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[var(--color-border)] px-2.5 py-2">
          <div className="truncate text-xs font-semibold">{title}</div>
          <div className="mt-0.5 text-[11px] leading-4 text-[var(--color-fg-subtle)]">{hint}</div>
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          <button
            type="button"
            onClick={() => onPick(null)}
            className="flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs hover:bg-[var(--color-bg-muted)]"
          >
            {t('networkMap.portPickNone')}
          </button>
          {ports.map((port) => {
            const taken = busy.has(port.name)
            return (
              <button
                key={port.id || port.name}
                type="button"
                onClick={() => onPick(port.name)}
                className="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--color-bg-muted)]"
              >
                <span className="truncate font-mono text-[11px]">{port.name}</span>
                <span className="shrink-0 text-[10px] text-[var(--color-fg-subtle)]">
                  {taken
                    ? t('networkMap.portInUse')
                    : port.up === true
                      ? t('networkMap.statusOk')
                      : port.up === false
                        ? t('networkMap.statusDown')
                        : ''}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>,
    document.body,
  )
}
