import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../icons'
import { useT } from '../../i18n/LocaleContext'

export type AppModalSize = 'sm' | 'md' | 'lg' | 'xl'

export type AppModalProps = {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  size?: AppModalSize
  /** Overrides default `common.close` aria-label when LocaleProvider is unavailable. */
  closeLabel?: string
}

const SIZE_CLASS: Record<AppModalSize, string> = {
  sm: 'app-modal-panel--sm',
  md: 'app-modal-panel--md',
  lg: 'app-modal-panel--lg',
  xl: 'app-modal-panel--xl',
}

/** Shared modal shell: portal, Escape, backdrop click, focus restore. */
export function AppModal({
  open,
  title,
  onClose,
  children,
  size = 'md',
  closeLabel,
}: AppModalProps) {
  const t = useT()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const resolvedClose = closeLabel ?? t('common.close')

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="app-modal-layer fixed inset-0 z-[200] flex items-stretch justify-center bg-[color-mix(in_srgb,var(--color-bg)_50%,black)] p-0 backdrop-blur-[2px] sm:items-center sm:p-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`app-modal-panel ${SIZE_CLASS[size]}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="app-modal-panel__header">
          <h2 id={titleId} className="app-modal-panel__title">
            {title}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="app-modal-panel__close"
            onClick={onClose}
            aria-label={resolvedClose}
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>
        <div className="app-modal-panel__body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
