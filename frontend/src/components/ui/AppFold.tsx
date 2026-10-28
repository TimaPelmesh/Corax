import { useEffect, useId, useState, type ReactNode } from 'react'

export type AppFoldProps = {
  title: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  /** Controlled open state. When set, `defaultOpen` is ignored after mount sync. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  summaryExtra?: ReactNode
}

/** Accessible collapsible section (details/summary replacement). */
export function AppFold({
  title,
  children,
  defaultOpen = false,
  open: openControlled,
  onOpenChange,
  className,
  summaryExtra,
}: AppFoldProps) {
  const controlled = openControlled !== undefined
  const [openUncontrolled, setOpenUncontrolled] = useState(defaultOpen)
  const open = controlled ? openControlled : openUncontrolled
  const panelId = useId()

  useEffect(() => {
    if (!controlled) setOpenUncontrolled(defaultOpen)
  }, [controlled, defaultOpen])

  function setOpen(next: boolean) {
    if (!controlled) setOpenUncontrolled(next)
    onOpenChange?.(next)
  }

  return (
    <div className={['app-fold', open ? 'app-fold--open' : '', className].filter(Boolean).join(' ')}>
      <div className="app-fold__summary">
        <button
          type="button"
          className="app-fold__trigger"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen(!open)}
        >
          <span className="app-fold__chevron" aria-hidden="true" />
          <span className="app-fold__title">{title}</span>
        </button>
        {summaryExtra ? <div className="app-fold__extra">{summaryExtra}</div> : null}
      </div>
      <div id={panelId} className="app-fold__body" hidden={!open} role="region">
        {children}
      </div>
    </div>
  )
}
