import type { ZabbixProblem } from '../../api'
import { Link } from 'react-router-dom'
import { useT } from '../../i18n/LocaleContext'

export function formatZabbixClock(clock: number | null | undefined, locale: string) {
  if (clock == null || !Number.isFinite(clock) || clock <= 0) return '—'
  try {
    return new Date(clock * 1000).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

/** Kept for callers that still want a compact one-line problem label. */
export function ZabbixProblemChip({ problem }: { problem: ZabbixProblem }) {
  return (
    <span className="truncate text-xs text-[var(--color-fg)]" title={problem.severity_label}>
      {problem.name || '—'}
    </span>
  )
}

export function ZabbixKbLink({ className }: { className?: string }) {
  const t = useT()
  return (
    <Link
      to="/knowledge-base/zabbix"
      className={className ?? 'text-[11px] font-medium text-[var(--color-primary)] no-underline hover:underline'}
    >
      {t('zabbixUi.openKb')}
    </Link>
  )
}
