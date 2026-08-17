import type { TicketHandlerStats } from '../../api'
import { useT } from '../../i18n/LocaleContext'

type Props = {
  stats: TicketHandlerStats | null
  enabled?: boolean
}

export function HandlerOverviewCards({ stats, enabled }: Props) {
  const t = useT()
  const total = stats?.total ?? 0
  const created = stats?.created_ticket ?? 0
  const errors = stats?.error ?? 0
  const latency =
    stats?.avg_latency_ms != null && Number.isFinite(stats.avg_latency_ms)
      ? `${Math.round(stats.avg_latency_ms)} ms`
      : t('ticketHandler.kpiLatencyEmpty')

  return (
    <div className="flex flex-wrap gap-3 text-sm">
      <span
        className={`rounded-lg px-3 py-1.5 ${
          enabled
            ? 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200'
            : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
        }`}
      >
        {enabled ? t('ticketHandler.statusOn') : t('ticketHandler.statusOff')}
      </span>
      <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
        {t('ticketHandler.kpiTotal')}: <strong>{total}</strong>
      </span>
      <span className="rounded-lg bg-sky-500/10 px-3 py-1.5 text-sky-900 dark:text-sky-200">
        {t('ticketHandler.kpiCreated')}: <strong>{created}</strong>
      </span>
      <span className="rounded-lg bg-red-500/10 px-3 py-1.5 text-red-800 dark:text-red-200">
        {t('ticketHandler.kpiErrors')}: <strong>{errors}</strong>
      </span>
      <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
        {t('ticketHandler.kpiLatency')}: <strong>{latency}</strong>
      </span>
    </div>
  )
}
