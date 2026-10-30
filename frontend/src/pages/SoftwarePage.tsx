import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type CatalogFilterItem,
  type CatalogKind,
  type DashboardSegmentComputer,
  type SoftwareCatalogRow,
} from '../api'
import { useAuth } from '../AuthContext'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { IconDetails } from '../components/icons'
import { Skeleton, TableSkeleton } from '../components/Skeleton'
import { useT } from '../i18n/LocaleContext'
import { peekCache, putCache } from '../lib/viewCache'
import { useToast } from '../ToastContext'
import { catalogFilterKey } from './knowledgeZabbixModel'

function kindBtnClass(active: boolean) {
  return `w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition ${
    active
      ? 'bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] font-medium text-[var(--color-primary)]'
      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]'
  }`
}

function filterKey(f: CatalogFilterItem) {
  return catalogFilterKey(f.kind, f.name)
}

const SOFTWARE_ROW_PX = 36

function softwareCacheKey(kind: string, query: string) {
  return `software:${kind}:${query.trim()}`
}

function useRowWindow(count: number) {
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 40 })

  useEffect(() => {
    const el = ref.current
    if (!el || count <= 80) return
    el.scrollTop = 0
    let frame = 0
    const measure = () => {
      const start = Math.max(0, Math.floor(el.scrollTop / SOFTWARE_ROW_PX) - 12)
      const visible = Math.ceil(el.clientHeight / SOFTWARE_ROW_PX) + 28
      const end = Math.min(count, start + visible)
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    }
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    measure()
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(onScroll)
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [count])

  return { ref, start: range.start, end: Math.max(range.end, range.start) }
}

export function SoftwarePage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const canDownloadAgent = Boolean(user?.is_superuser)
  const [kind, setKind] = useState<CatalogKind>('software')
  const [query, setQuery] = useState('')
  const initialCatalog = peekCache<SoftwareCatalogRow[]>(softwareCacheKey('software', ''))
  const [rows, setRows] = useState<SoftwareCatalogRow[]>(initialCatalog ?? [])
  const [loading, setLoading] = useState(!initialCatalog)
  const [filters, setFilters] = useState<CatalogFilterItem[]>([])
  const [hosts, setHosts] = useState<DashboardSegmentComputer[] | null>(null)
  const [hostsTotal, setHostsTotal] = useState(0)
  const [hostsLoading, setHostsLoading] = useState(false)
  const [computerId, setComputerId] = useState<number | null>(null)
  const hostsPanelRef = useRef<HTMLDivElement>(null)
  const hostsListRef = useRef<HTMLDivElement>(null)

  const catalogSections = useMemo<Array<{ kind: CatalogKind; label: string }>>(
    () => [
      { kind: 'software', label: t('software.kinds.software') },
      { kind: 'peripheral', label: t('software.kinds.peripheral') },
      { kind: 'os', label: t('software.kinds.os') },
      { kind: 'cpu', label: t('software.kinds.cpu') },
      { kind: 'gpu', label: t('software.kinds.gpu') },
      { kind: 'ram', label: t('software.kinds.ram') },
      { kind: 'physical_disk', label: t('software.kinds.physical_disk') },
      { kind: 'manufacturer', label: t('software.kinds.manufacturer') },
      { kind: 'motherboard', label: t('software.kinds.motherboard') },
    ],
    [t],
  )

  const kindLabel = useCallback(
    (k: CatalogKind) => catalogSections.find((s) => s.kind === k)?.label ?? k,
    [catalogSections],
  )

  const load = useCallback(
    async (nextKind: CatalogKind, q: string) => {
      const key = softwareCacheKey(nextKind, q)
      if (!peekCache<SoftwareCatalogRow[]>(key)) setLoading(true)
      try {
        const next = await api.catalog(nextKind, q.trim() || undefined, 5000)
        putCache(key, next)
        setRows(next)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('common.error'))
      } finally {
        setLoading(false)
      }
    },
    [t, toast],
  )

  useEffect(() => {
    const key = softwareCacheKey(kind, query)
    const cached = peekCache<SoftwareCatalogRow[]>(key)
    if (cached) {
      setRows(cached)
      setLoading(false)
    }
    const timer = window.setTimeout(() => {
      void load(kind, query)
    }, cached ? 0 : 320)
    return () => window.clearTimeout(timer)
  }, [kind, query, load])

  useEffect(() => {
    if (!filters.length) {
      setHosts(null)
      setHostsTotal(0)
      setHostsLoading(false)
      return
    }
    let cancelled = false
    setHostsLoading(true)
    void api
      .catalogFilterHosts(filters)
      .then((r) => {
        if (cancelled) return
        const items =
          r.items && r.items.length
            ? r.items
            : (r.hostnames || []).map((hostname, idx) => ({
                id: -idx - 1,
                hostname,
              }))
        setHosts(items)
        setHostsTotal(r.total ?? items.length)
      })
      .catch((e) => {
        if (cancelled) return
        toast.error(e instanceof Error ? e.message : t('common.error'))
        setHosts([])
        setHostsTotal(0)
      })
      .finally(() => {
        if (!cancelled) setHostsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [filters, t, toast])

  function toggleFilter(name: string) {
    setFilters((prev) => {
      const key = filterKey({ kind, name })
      if (prev.some((f) => filterKey(f) === key)) {
        return prev.filter((f) => filterKey(f) !== key)
      }
      return [...prev, { kind, name }]
    })
  }

  function removeFilter(f: CatalogFilterItem) {
    setFilters((prev) => prev.filter((x) => filterKey(x) !== filterKey(f)))
  }

  const sortedHosts = useMemo(() => {
    if (!hosts) return null
    return [...hosts].sort((a, b) =>
      a.hostname.localeCompare(b.hostname, undefined, { sensitivity: 'base' }),
    )
  }, [hosts])

  useEffect(() => {
    if (hostsLoading || hosts === null) return
    if (hostsListRef.current) hostsListRef.current.scrollTop = 0
  }, [hosts, hostsLoading, filters])

  const nameColumnLabel =
    kind === 'ram'
      ? t('software.columns.ram')
      : kind === 'gpu'
        ? t('software.columns.gpu')
        : kind === 'physical_disk'
          ? t('software.columns.disk')
          : kind === 'motherboard'
            ? t('software.columns.motherboard')
            : t('software.columns.name')

  const activeKeys = useMemo(() => new Set(filters.map(filterKey)), [filters])
  const windowed = rows.length > 80
  const rowWindow = useRowWindow(windowed ? rows.length : 0)
  const visibleRows = windowed ? rows.slice(rowWindow.start, rowWindow.end) : rows
  const padTop = windowed ? rowWindow.start * SOFTWARE_ROW_PX : 0
  const padBottom = windowed ? Math.max(0, rows.length - rowWindow.end) * SOFTWARE_ROW_PX : 0

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 flex-col overflow-auto lg:overflow-hidden">
      <h1 className="sr-only">{t('titles.software')}</h1>
      <div className="grid min-h-0 flex-1 items-stretch gap-3 overflow-hidden lg:grid-cols-[13.25rem_minmax(0,1fr)_minmax(18rem,22rem)]">
        <aside className="app-panel flex min-h-0 flex-col overflow-hidden !p-0">
          <p className="border-b border-[var(--color-border)] px-3 py-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--color-fg-subtle)]">
            {t('software.filtersRail')}
          </p>
          <nav
            className="flex gap-1 overflow-x-auto p-1.5 lg:flex-col lg:gap-0.5 lg:overflow-auto"
            aria-label={t('software.filtersRail')}
          >
            {catalogSections.map((s) => (
              <button
                key={s.kind}
                type="button"
                onClick={() => setKind(s.kind)}
                className={`${kindBtnClass(kind === s.kind)} shrink-0 whitespace-nowrap lg:w-full lg:whitespace-normal`}
                aria-pressed={kind === s.kind}
              >
                {s.label}
              </button>
            ))}
          </nav>
          {filters.length ? (
            <div className="mt-auto flex min-h-0 flex-col gap-1.5 border-t border-[var(--color-border)] p-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--color-fg-subtle)]">
                  {t('software.activeFilters')}
                </span>
                <button
                  type="button"
                  onClick={() => setFilters([])}
                  className="text-[11px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                >
                  {t('software.clearFilters')}
                </button>
              </div>
              <div className="flex max-h-40 flex-col gap-1 overflow-auto">
                {filters.map((f) => (
                  <button
                    key={filterKey(f)}
                    type="button"
                    onClick={() => removeFilter(f)}
                    className="flex w-full items-center gap-1.5 rounded-md bg-[var(--color-bg-muted)] px-2 py-1 text-left text-xs text-[var(--color-fg)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-bg-muted))]"
                    title={t('software.removeFilter')}
                  >
                    <span className="shrink-0 text-[var(--color-fg-subtle)]">{kindLabel(f.kind)}</span>
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span aria-hidden className="text-[var(--color-fg-subtle)]">
                      ×
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </aside>

        <section key={`sw-${kind}`} className="app-panel flex min-h-0 flex-col overflow-hidden !p-0">
          <div className="flex flex-col gap-2 border-b border-[var(--color-border)] px-3 py-2 sm:flex-row sm:items-center">
            <input
              id="sw-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('software.searchPlaceholder')}
              className="app-input min-w-0 w-full flex-1 !min-h-9"
            />
            <span className="shrink-0 text-xs tabular-nums text-[var(--color-fg-subtle)]">
              {loading ? t('software.refreshing') : t('software.rowsCount', { count: rows.length })}
            </span>
          </div>
          <div ref={rowWindow.ref} className="app-table-shell min-h-0 flex-1 overflow-auto overscroll-contain">
            {loading && rows.length === 0 ? (
              <TableSkeleton rows={10} cols={2} />
            ) : (
            <table className="app-table min-w-full text-left text-sm">
              <thead className="sticky top-0 z-10 border-b border-[var(--color-border)] bg-[var(--color-surface)] text-[12px] font-medium text-[var(--color-fg-subtle)]">
                <tr>
                  <th className="px-3 py-2 font-medium">{nameColumnLabel}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('software.columns.pcs')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-3 py-12 text-center text-[var(--color-fg-subtle)]">
                      <p>{query.trim() ? t('software.emptySearch') : t('software.empty')}</p>
                      {query.trim() ? (
                        <button type="button" className="app-btn app-btn-secondary mt-3" onClick={() => setQuery('')}>
                          {t('software.clearSearch')}
                        </button>
                      ) : canDownloadAgent ? (
                        <Link to="/settings/agent-bundle" className="app-btn app-btn-primary mt-3">
                          {t('common.downloadAgent')}
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ) : (
                  <>
                    {padTop > 0 ? (
                      <tr aria-hidden>
                        <td colSpan={2} style={{ height: padTop, padding: 0, border: 0 }} />
                      </tr>
                    ) : null}
                    {visibleRows.map((r) => {
                    const active = activeKeys.has(filterKey({ kind, name: r.name }))
                    return (
                      <tr
                        key={r.name}
                        style={{ height: SOFTWARE_ROW_PX }}
                        className={`cursor-pointer ${
                          active
                            ? 'bg-[color-mix(in_srgb,var(--color-primary)_8%,transparent)] shadow-[inset_2px_0_0_var(--color-primary)]'
                            : 'hover:bg-[var(--color-bg-muted)]/70'
                        }`}
                        onClick={() => toggleFilter(r.name)}
                      >
                        <td className="px-3 py-2" title={r.version ? `${r.name} — ${r.version}` : r.name}>
                          <div className="flex min-w-0 items-baseline gap-2">
                            <span className="min-w-0 truncate text-[var(--color-fg)]">{r.name}</span>
                            {r.version ? (
                              <span className="shrink-0 font-mono text-[11px] text-[var(--color-fg-subtle)]">
                                {r.version}
                              </span>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-[var(--color-fg-muted)]">{r.count}</td>
                      </tr>
                    )
                  })}
                    {padBottom > 0 ? (
                      <tr aria-hidden>
                        <td colSpan={2} style={{ height: padBottom, padding: 0, border: 0 }} />
                      </tr>
                    ) : null}
                  </>
                )}
              </tbody>
            </table>
            )}
          </div>
        </section>

        <section ref={hostsPanelRef} className="app-panel flex min-h-0 flex-col overflow-hidden !p-0">
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
            <h2 className="text-[13px] font-medium text-[var(--color-fg)]">{t('software.installedOnTitle')}</h2>
            {filters.length ? (
              <span className="text-xs tabular-nums text-[var(--color-fg-subtle)]">
                {hostsLoading ? '…' : hostsTotal}
                {filters.length > 1 ? ` · ${t('software.filtersAnd')}` : ''}
              </span>
            ) : null}
          </div>

          {!filters.length ? (
            <div className="app-empty-state !rounded-none border-0 m-3">
              {t('software.selectRowHint')}
            </div>
          ) : hostsLoading ? (
            <div className="space-y-2 p-3" role="status" aria-busy="true">
              <span className="sr-only">{t('software.loadingHosts')}</span>
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-10 rounded-lg" />
              ))}
            </div>
          ) : sortedHosts && sortedHosts.length ? (
            <>
              <div ref={hostsListRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                <ul>
                  {sortedHosts.map((pc, idx) => {
                    const clickable = pc.id > 0
                    const meta = [
                      pc.os_summary || pc.os_name,
                      pc.cpu,
                      pc.ram_gb != null ? t('computers.ramValue', { value: pc.ram_gb }) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                    return (
                      <li
                        key={`${pc.id}-${pc.hostname}`}
                        className={idx > 0 ? 'border-t border-[var(--color-border)]' : undefined}
                      >
                        <div className="flex items-center gap-2 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-[13px] text-[var(--color-fg)]">{pc.hostname}</div>
                            {meta ? (
                              <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-subtle)]">{meta}</div>
                            ) : null}
                          </div>
                          {clickable ? (
                            <button
                              type="button"
                              onClick={() => setComputerId(pc.id)}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] transition hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-primary)]"
                              title={t('software.openDetails')}
                              aria-label={t('software.openDetails')}
                            >
                              <IconDetails className="h-3.5 w-3.5" />
                            </button>
                          ) : null}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
              {hostsTotal > sortedHosts.length ? (
                <p className="border-t border-[var(--color-border)] px-3 py-2 text-[11px] text-[var(--color-fg-subtle)]">
                  {t('software.shownCount', { count: sortedHosts.length })}
                </p>
              ) : null}
            </>
          ) : (
            <p className="px-4 py-8 text-sm text-[var(--color-fg-subtle)]">{t('software.noDataForSelection')}</p>
          )}
        </section>
      </div>

      {computerId != null ? (
        <ComputerDetailModal computerId={computerId} onClose={() => setComputerId(null)} />
      ) : null}
    </div>
  )
}
