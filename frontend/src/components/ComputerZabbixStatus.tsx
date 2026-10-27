import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ZabbixHostStatus } from '../api'
import { useT } from '../i18n/LocaleContext'

export function ComputerZabbixStatus({ hostname }: { hostname: string }) {
  const t = useT()
  const [data, setData] = useState<ZabbixHostStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!hostname.trim()) {
      setLoading(false)
      return
    }
    try {
      setData(await api.zabbixHostStatus(hostname))
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [hostname])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">{t('zabbixUi.loading')}</p>
    )
  }

  if (!data || !data.enabled) {
    return null
  }

  if (!data.available) {
    return (
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Zabbix: {data.message || t('zabbixUi.unavailable')}
      </p>
    )
  }

  if (!data.matched || !data.host) {
    return (
      <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
        Zabbix: {t('zabbixUi.pcNotMatched')}{' '}
        <Link to="/knowledge-base/zabbix" className="text-[var(--color-primary)] no-underline hover:underline">
          {t('zabbixUi.openKb')}
        </Link>
      </p>
    )
  }

  const hostLabel = data.host.name || data.host.host
  const problems = data.problems?.slice(0, 3) ?? []

  return (
    <div className="mt-2 border-t border-[var(--color-border)]/70 pt-2 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="min-w-0 text-[var(--color-fg-muted)]">
          <span className="font-medium text-[var(--color-fg)]">Zabbix</span>
          <span className="mx-1.5 text-[var(--color-fg-subtle)]">·</span>
          <span className="truncate" title={hostLabel}>
            {hostLabel}
          </span>
          {data.host.ip ? <span className="text-[var(--color-fg-subtle)]"> ({data.host.ip})</span> : null}
          <span className="mx-1.5 text-[var(--color-fg-subtle)]">·</span>
          {t('zabbixUi.pcProblems', { n: data.problems_total })}
        </p>
        <Link
          to="/knowledge-base/zabbix"
          className="shrink-0 text-[var(--color-primary)] no-underline hover:underline"
        >
          {t('zabbixUi.openKb')}
        </Link>
      </div>
      {problems.length ? (
        <ul className="mt-1.5 space-y-0.5 text-[var(--color-fg)]">
          {problems.map((p) => (
            <li key={p.eventid || p.name} className="truncate">
              <span className="text-[var(--color-fg-muted)]">{p.severity_label}</span>
              <span className="mx-1 text-[var(--color-fg-subtle)]">·</span>
              {p.name || '—'}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
