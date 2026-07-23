import type { ReactNode } from 'react'

type PageHeaderProps = {
  icon: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

/** Shared page chrome: icon + title + subtitle (+ optional actions). */
export function PageHeader({ icon, title, subtitle, actions }: PageHeaderProps) {
  return (
    <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
      <div className="page-hero-icon mt-0.5 shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="page-title">{title}</h1>
            {subtitle ? (
              <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">{subtitle}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      </div>
    </div>
  )
}
