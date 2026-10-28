import type { ReactNode } from 'react'

type PageHeaderProps = {
  /** Accepted for call-site compatibility; chrome stays content-first (nav names the page). */
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

/** Content-first page chrome: navigation already names the page, so only useful actions remain. */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div> : null}
      {subtitle ? <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{subtitle}</p> : null}
    </>
  )
}
