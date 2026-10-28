import type { ReactNode } from 'react'

export type StatusPillTone = 'success' | 'warning' | 'error' | 'info' | 'neutral'

export type StatusPillProps = {
  tone?: StatusPillTone
  children: ReactNode
  className?: string
}

/** Compact status indicator using theme `--color-{tone}-*` tokens. */
export function StatusPill({ tone = 'neutral', children, className }: StatusPillProps) {
  return (
    <span
      className={['app-status-pill', `app-status-pill--${tone}`, className].filter(Boolean).join(' ')}
      role="status"
    >
      {children}
    </span>
  )
}
