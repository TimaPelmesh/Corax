import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ZabbixHostRow, type ZabbixOverview, type ZabbixProblem } from '../api'
import { useAuth } from '../AuthContext'
import { formatZabbixClock } from '../components/zabbix/zabbixUi'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type Tab = 'problems' | 'hosts'

function hostKeys(value: string) {
  const raw = value.trim().toLowerCase()
  if (!raw) return []
  const short = raw.split('.')[0]
  return short && short !== raw ? [raw, short] : [raw]
}

function severityRank(value: number) {
  return Number.isFinite(value) ? value : 0
}

function severityClass(value: number) {
  if (value >= 5) return 'bg-rose-50 text-rose-800 dark:bg-rose-500/15 dark:text-rose-100'
  if (value >= 4) return 'bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100'
  if (value >= 3) return 'bg-orange-50 text-orange-900 dark:bg-orange-500/15 dark:text-orange-100'
  if (value >= 2) return 'bg-sky-50 text-sky-900 dark:bg-sky-500/15 dark:text-sky-100'
  return 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
}

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
  const [severity, setSeverity] = useState<number | 'all'>('all')
  const [pcByHost, setPcByHost] = useState<Map<string, number>>(() => new Map())

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

  useEffect(() => {
    let cancelled = false
    void api
      .computers({ limit: 1000, sort: 'host', sort_dir: 'asc' })
      .then((page) => {
        if (cancelled) return
        const map = new Map<string, number>()
        for (const pc of page.items) {
          for (const key of hostKeys(pc.hostname || '')) {
            if (!map.has(key)) map.set(key, pc.id)
          }
        }
        setPcByHost(map)
      })
      .catch(() => {
        if (!cancelled) setPcByHost(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [])

  const computerIdFor = useCallback(
    (names: string[]) => {
      for (const name of names) {
        for (const key of hostKeys(name)) {
          const id = pcByHost.get(key)
          if (id) return id
        }
      }
      return null
    },
    [pcByHost],
  )

  const severityCounts = useMemo(() => {
    const counts = new Map<number, number>()
    for (const problem of problems) {
      const rank = severityRank(problem.severity)
      counts.set(rank, (counts.get(rank) || 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[0] - a[0])
  }, [problems])

  const filteredProblems = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return problems
      .filter((p) => {
        if (severity !== 'all' && severityRank(p.severity) !== severity) return false
        if (!needle) return true
        const hay = `${p.name} ${(p.hosts || []).join(' ')}`.toLowerCase()
        return hay.includes(needle)
      })
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.clock || 0) - (a.clock || 0))
  }, [problems, q, severity])

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
  const zabbixHref = useMemo(() => {
    const raw = (overview?.ui_url || '').trim()
    if (!raw) return ''
    if (/^https?:\/\//i.test(raw)) return raw
    if (/^[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(raw)) return `http://${raw}`
    return ''
  }, [overview?.ui_url])

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
          <Link
            to="/risks"
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium no-underline hover:bg-[var(--color-bg-muted)]"
          >
            {t('zabbixUi.riskLink')}
          </Link>
          {user?.is_superuser ? (
            <Link
              to="/settings/zabbix"
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium no-underline hover:bg-[var(--color-bg-muted)]"
            >
              {t('zabbixUi.settings')}
            </Link>
          ) : null}
          {zabbixHref ? (
            <a
              href={zabbixHref}
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

          <p className="text-sm text-[var(--color-fg-muted)]">{t('zabbixUi.kbIntro')}</p>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('zabbixUi.searchPlaceholder')}
              className="min-w-[12rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:max-w-xs"
            />
            {q.trim() ? (
              <button type="button" className="text-sm font-medium text-[var(--color-primary)]" onClick={() => setQ('')}>
                {t('zabbixUi.clearSearch')}
              </button>
            ) : null}
          </div>

          {tab === 'problems' && severityCounts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setSeverity('all')}
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  severity === 'all' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
                }`}
              >
                {t('zabbixUi.severityAll')} · {problems.length}
              </button>
              {severityCounts.map(([rank, count]) => {
                const label = problems.find((item) => severityRank(item.severity) === rank)?.severity_label || String(rank)
                return (
                  <button
                    key={rank}
                    type="button"
                    onClick={() => setSeverity(rank)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      severity === rank ? 'bg-[var(--color-primary)] text-white' : severityClass(rank)
                    }`}
                  >
                    {label} · {count}
                  </button>
                )
              })}
            </div>
          ) : null}

          {tab === 'problems' ? (
            <div className="app-table-shell overflow-x-auto rounded-md border border-[var(--color-border)]">
              <table className="app-table w-full min-w-[40rem] border-collapse text-left text-sm">
                <thead className="bg-[var(--color-bg-muted)] text-[13px] font-medium text-[var(--color-fg-subtle)]">
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
                        <td className="px-3 py-2 align-top">
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${severityClass(severityRank(p.severity))}`}>
                            {p.severity_label || '—'}
                          </span>
                        </td>
                        <td className="px-3 py-2 align-top font-medium text-[var(--color-fg)]">{p.name || '—'}</td>
                        <td className="px-3 py-2 align-top text-[var(--color-fg-muted)]">
                          {(p.hosts || []).length === 0 ? (
                            '—'
                          ) : (
                            <span className="flex flex-wrap gap-x-2 gap-y-1">
                              {(p.hosts || []).map((name) => {
                                const id = computerIdFor([name])
                                return id ? (
                                  <Link key={name} to={`/computers?computer=${id}`} className="font-medium text-[var(--color-primary)] no-underline hover:underline" title={t('zabbixUi.openComputer')}>
                                    {name}
                                  </Link>
                                ) : (
                                  <span key={name} title={t('zabbixUi.notInFleet')}>
                                    {name}
                                  </span>
                                )
                              })}
                            </span>
                          )}
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
            <div className="app-table-shell overflow-x-auto rounded-md border border-[var(--color-border)]">
              <table className="app-table w-full min-w-[36rem] border-collapse text-left text-sm">
                <thead className="bg-[var(--color-bg-muted)] text-[13px] font-medium text-[var(--color-fg-subtle)]">
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
                        <td className="px-3 py-2 font-medium text-[var(--color-fg)]">
                          {(() => {
                            const id = computerIdFor([h.host, h.name])
                            const label = h.name || '—'
                            return id ? (
                              <Link to={`/computers?computer=${id}`} className="text-[var(--color-primary)] no-underline hover:underline" title={t('zabbixUi.openComputer')}>
                                {label}
                              </Link>
                            ) : (
                              label
                            )
                          })()}
                        </td>
                        <td className="px-3 py-2 text-[var(--color-fg-muted)]">{h.host || '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-[var(--color-fg-muted)]">{h.ip || '—'}</td>
                        <td className="px-3 py-2 text-[var(--color-fg-muted)]">
                          <div>{h.status === 1 ? t('zabbixUi.hostDisabled') : t('zabbixUi.hostEnabled')}</div>
                          <div className="mt-0.5 text-[11px]">
                            {computerIdFor([h.host, h.name]) ? t('zabbixUi.inFleet') : t('zabbixUi.notInFleet')}
                          </div>
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
