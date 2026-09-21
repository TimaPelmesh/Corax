import { useEffect } from 'react'
import { createPortal } from 'react-dom'

export type MapContextAction = {
  id: string
  label: string
  danger?: boolean
  disabled?: boolean
}

type Props = {
  x: number
  y: number
  actions: MapContextAction[]
  onPick: (id: string) => void
  onClose: () => void
}

export function NetworkMapContextMenu({ x, y, actions, onPick, onClose }: Props) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onDown = (event: MouseEvent) => {
      if (event.button === 0) onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const left = Math.max(8, Math.min(x, window.innerWidth - 208))
  const top = Math.max(8, Math.min(y, window.innerHeight - 12 - actions.length * 32))
  return createPortal(
    <div
      className="network-map-ctx fixed z-[140] min-w-[11.5rem] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[0_18px_40px_-24px_rgba(0,0,0,0.55)]"
      style={{ left, top }}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={action.disabled}
          onClick={() => onPick(action.id)}
          className={`block w-full px-3 py-1.5 text-left text-[12px] hover:bg-[var(--color-bg-muted)] disabled:opacity-40 ${
            action.danger ? 'text-red-600 dark:text-red-400' : 'text-[var(--color-fg)]'
          }`}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  )
}
