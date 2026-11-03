import type { ReactNode } from 'react'
import { StatusPill, type StatusPillTone } from '../ui/StatusPill'

const BAR: Record<StatusPillTone, string> = {
  success: 'bg-[var(--color-success-fg)]',
  warning: 'bg-[var(--color-warning-fg)]',
  error: 'bg-[var(--color-error-fg)]',
  info: 'bg-[var(--color-info-fg)]',
  neutral: 'bg-[var(--color-border-strong)]',
}

export type StatusFact = {
  label: string
  value: string
  title?: string
  mono?: boolean
}

export function SettingsStatusBoard({
  tone,
  kicker,
  title,
  detail,
  facts,
  extra,
  actions,
}: {
  tone: StatusPillTone
  kicker: string
  title: string
  detail?: string
  facts: StatusFact[]
  extra?: ReactNode
  actions?: ReactNode
}) {
  return (
    <section className="app-panel overflow-hidden !p-0" aria-live="polite">
      <div className={`h-1 ${BAR[tone]}`} />
      <div className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 max-w-2xl">
            <StatusPill tone={tone}>{kicker}</StatusPill>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-[var(--color-fg)]">{title}</h2>
            {detail ? <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">{detail}</p> : null}
          </div>
          {actions ? (
            <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:flex-wrap lg:max-w-sm lg:justify-end">{actions}</div>
          ) : null}
        </div>
        {facts.length > 0 ? (
          <dl className={`grid grid-cols-2 gap-2 ${facts.length > 3 ? 'lg:grid-cols-4' : 'sm:grid-cols-3'}`}>
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2.5"
              >
                <dt className="text-[11px] font-medium text-[var(--color-fg-subtle)]">{fact.label}</dt>
                <dd
                  className={`mt-0.5 truncate text-sm font-semibold text-[var(--color-fg)] ${fact.mono ? 'font-mono text-[13px]' : ''}`}
                  title={fact.title || fact.value}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {extra}
      </div>
    </section>
  )
}
