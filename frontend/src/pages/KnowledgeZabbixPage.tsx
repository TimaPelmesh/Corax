import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ZabbixHostRow, type ZabbixOverview, type ZabbixProblem } from '../api'
import { useAuth } from '../AuthContext'
import { formatZabbixClock } from '../components/zabbix/zabbixUi'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type Tab = 'problems' | 'hosts'

export function KnowledgeZabbixPage() {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const { user } = useAuth()
  const [overview, setOverview] = useState<ZabbixOverview | null>(null)
  const [problems, setProblems] = useState<ZabbixProblem[]>([])
  const [hosts, setHosts] = useState<ZabbixHostRow[]>([])
  const [problemsTotal, setProblemsTotal] = useState<number | null>(null)
  const [hostsTotal, setHostsTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('problems')
  const [q, setQ] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [ov, pr, hs] = await Promise.all([
        api.zabbixOverview(),
        api.zabbixProblems(80),
        api.zabbixHosts(200),
      ])
      setOverview(ov)
      setProblems(pr.items || [])
      setProblemsTotal(pr.total ?? null)
      setHosts(hs.items || [])
      setHostsTotal(hs.total ?? null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const filteredProblems = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return problems
    return problems.filter((p) => {
      const hay = `${p.name} ${(p.hosts || []).join(' ')}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [problems, q])

  const filteredHosts = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return hosts
    return hosts.filter((h) => {
      const hay = `${h.name} ${h.host} ${h.ip}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [hosts, q])

  const enabled = Boolean(overview?.enabled)
  const available = Boolean(overview?.available)

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <h1 className="sr-only">{t('titles.zabbixData')}</h1>

      <header className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5">
            {(
              [
                ['problems', t('zabbixUi.tabProblems'), problemsTotal],
                ['hosts', t('zabbixUi.tabHosts'), hostsTotal],
              ] as const
            ).map(([id, label, total]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  tab === id
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]'
                }`}
              >
                {label}
                {total != null ? <span className="ml-1 opacity-80">({total})</span> : null}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? t('zabbixUi.loading') : t('zabbixUi.refresh')}
          </button>
          {user?.is_superuser ? (
            <Link
              to="/settings/zabbix"
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium no-underline hover:bg-[var(--color-bg-muted)]"
            >
              {t('zabbixUi.settings')}
            </Link>
          ) : null}
          {overview?.ui_url ? (
            <a
              href={overview.ui_url}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white no-underline"
            >
              {t('zabbixUi.openZabbix')}
            </a>
          ) : null}
        </div>
      </header>

      {!enabled ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('zabbixUi.kbDisabled')}</p>
      ) : !available ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{overview?.message || t('zabbixUi.unavailable')}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3 text-sm">
            <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
              {t('zabbixUi.hosts')}: <strong>{overview?.hosts_total ?? '—'}</strong>
            </span>
            <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
              {t('zabbixUi.problems')}: <strong>{overview?.problems_total ?? '—'}</strong>
            </span>
            {overview?.version ? (
              <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
                {t('zabbixUi.version')}: <strong>{overview.version}</strong>
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('zabbixUi.searchPlaceholder')}
              className="min-w-[12rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:max-w-xs"
            />
          </div>

          {tab === 'problems' ? (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
                <thead className="bg-[var(--color-bg-muted)] text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  <tr>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colSeverity')}</th>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colProblem')}</th>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colHosts')}</th>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colWhen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProblems.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-[var(--color-fg-subtle)]">
                        {t('zabbixUi.noProblems')}
                      </td>
                    </tr>
                  ) : (
                    filteredProblems.map((p) => (
                      <tr
                        key={p.eventid || `${p.name}-${p.clock}`}
                        className="border-b border-[var(--color-border)]/70 hover:bg-[var(--color-bg-muted)]/50"
                      >
                        <td className="px-3 py-2 align-top text-[var(--color-fg-muted)]">{p.severity_label}</td>
                        <td className="px-3 py-2 align-top font-medium text-[var(--color-fg)]">{p.name || '—'}</td>
                        <td className="px-3 py-2 align-top text-[var(--color-fg-muted)]">
                          {(p.hosts || []).join(', ') || '—'}
                        </td>
                        <td className="px-3 py-2 align-top tabular-nums text-[var(--color-fg-muted)]">
                          {formatZabbixClock(p.clock, locale)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
              <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
                <thead className="bg-[var(--color-bg-muted)] text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  <tr>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colName')}</th>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colHost')}</th>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colIp')}</th>
                    <th className="px-3 py-2 font-semibold">{t('zabbixUi.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredHosts.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-3 py-8 text-center text-[var(--color-fg-subtle)]">
                        {t('zabbixUi.emptyHosts')}
                      </td>
                    </tr>
                  ) : (
                    filteredHosts.map((h) => (
                      <tr
                        key={h.hostid || h.host}
                        className="border-b border-[var(--color-border)]/70 hover:bg-[var(--color-bg-muted)]/50"
                      >
                        <td className="px-3 py-2 font-medium text-[var(--color-fg)]">{h.name || '—'}</td>
                        <td className="px-3 py-2 text-[var(--color-fg-muted)]">{h.host || '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-[var(--color-fg-muted)]">{h.ip || '—'}</td>
                        <td className="px-3 py-2 text-[var(--color-fg-muted)]">
                          {h.status === 1 ? t('zabbixUi.hostDisabled') : t('zabbixUi.hostEnabled')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
