import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type CatalogFilterItem,
  type CatalogKind,
  type DashboardSegmentComputer,
  type SoftwareCatalogRow,
} from '../api'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { IconDetails } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function filterBtnClass(active: boolean) {
  return `rounded-full px-3 py-1 text-xs font-medium transition ${
    active
      ? 'bg-[var(--color-primary)] text-white'
      : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]'
  }`
}

function filterKey(f: CatalogFilterItem) {
  return `${f.kind}::${f.name}`
}

export function SoftwarePage() {
  const t = useT()
  const toast = useToast()
  const [kind, setKind] = useState<CatalogKind>('software')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SoftwareCatalogRow[]>([])
  const [loading, setLoading] = useState(true)
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
      setLoading(true)
      try {
        setRows(await api.catalog(nextKind, q.trim() || undefined, 5000))
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('common.error'))
      } finally {
        setLoading(false)
      }
    },
    [t, toast],
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(kind, query)
    }, 320)
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
    if (hostsListRef.current) {
      hostsListRef.current.scrollTop = 0
    }
    hostsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [hosts, hostsLoading, filters])

  const nameColumnLabel =
    kind === 'ram'
      ? t('software.columns.ram')
      : kind === 'physical_disk'
        ? t('software.columns.disk')
        : kind === 'motherboard'
          ? t('software.columns.motherboard')
          : t('software.columns.name')

  const pcsSum = useMemo(() => rows.reduce((acc, r) => acc + r.count, 0), [rows])
  const activeKeys = useMemo(() => new Set(filters.map(filterKey)), [filters])

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <h1 className="sr-only">{t('titles.software')}</h1>
      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {t('software.statPositions')}: <strong>{loading ? '…' : rows.length}</strong>
        </span>
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {t('software.statMatches')}: <strong>{loading ? '…' : pcsSum}</strong>
        </span>
        {filters.length ? (
          <span className="rounded-lg bg-[color-mix(in_srgb,var(--color-primary)_12%,transparent)] px-3 py-1.5 text-[var(--color-primary)]">
            {t('software.statSelected')}: <strong>{hostsLoading ? '…' : hostsTotal}</strong>
            {filters.length > 1 ? (
              <span className="ml-1 opacity-80">· {t('software.filtersAnd')}</span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          id="sw-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('software.searchPlaceholder')}
          className="min-w-[12rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:max-w-xs"
        />
        <div className="flex flex-wrap gap-1">
          {catalogSections.map((s) => (
            <button
              key={s.kind}
              type="button"
              onClick={() => setKind(s.kind)}
              className={filterBtnClass(kind === s.kind)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {loading ? (
          <span className="text-xs text-[var(--color-fg-subtle)]">{t('software.refreshing')}</span>
        ) : null}
      </div>

      {filters.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {t('software.activeFilters')}
          </span>
          {filters.map((f) => (
            <button
              key={filterKey(f)}
              type="button"
              onClick={() => removeFilter(f)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[color-mix(in_srgb,var(--color-primary)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)] px-2.5 py-1 text-xs text-[var(--color-fg)] transition hover:bg-[color-mix(in_srgb,var(--color-primary)_18%,transparent)]"
              title={t('software.removeFilter')}
            >
              <span className="shrink-0 text-[var(--color-fg-subtle)]">{kindLabel(f.kind)}</span>
              <span className="min-w-0 truncate font-medium">{f.name}</span>
              <span aria-hidden className="opacity-60">
                ×
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setFilters([])}
            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
          >
            {t('software.clearFilters')}
          </button>
        </div>
      ) : null}

      <div key={`sw-${kind}`} className="grid items-start gap-4 lg:grid-cols-5">
        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] lg:col-span-3">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
              <tr>
                <th className="px-3 py-2.5">{nameColumnLabel}</th>
                <th className="px-3 py-2.5 text-right">{t('software.columns.pcs')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={2} className="px-3 py-10 text-center text-[var(--color-fg-subtle)]">
                    <p>{query.trim() ? t('software.emptySearch') : t('software.empty')}</p>
                    {query.trim() ? (
                      <button
                        type="button"
                        className="mt-3 rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-muted)]"
                        onClick={() => setQuery('')}
                      >
                        {t('software.clearSearch')}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ) : loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={2} className="px-3 py-10 text-center text-[var(--color-fg-subtle)]">
                    {t('common.loading')}
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const active = activeKeys.has(filterKey({ kind, name: r.name }))
                  return (
                    <tr
                      key={r.name}
                      className={`cursor-pointer border-t border-[var(--color-border)]/70 transition ${
                        active
                          ? 'bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]'
                          : 'hover:bg-[var(--color-bg-muted)]/50'
                      }`}
                      onClick={() => toggleFilter(r.name)}
                    >
                      <td className="px-3 py-2.5" title={r.version ? `${r.name} — ${r.version}` : r.name}>
                        <div className="font-medium leading-snug text-[var(--color-fg)]">{r.name}</div>
                        {r.version ? (
                          <div className="mt-0.5 font-mono text-[11px] text-[var(--color-fg-subtle)]">{r.version}</div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-[var(--color-fg-muted)]">{r.count}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>

        <div
          ref={hostsPanelRef}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 lg:col-span-2 lg:sticky lg:top-4 lg:z-10 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:overscroll-contain"
        >
          <h2 className="text-[0.95rem] font-medium tracking-tight text-[var(--color-fg)]">
            {t('software.installedOnTitle')}
          </h2>

          {!filters.length ? (
            <p className="mt-4 text-sm text-[var(--color-fg-subtle)]">{t('software.selectRowHint')}</p>
          ) : hostsLoading ? (
            <p className="mt-4 text-sm text-[var(--color-fg-subtle)]">{t('software.loadingHosts')}</p>
          ) : sortedHosts && sortedHosts.length ? (
            <>
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                {t('software.exactPackageName')}{' '}
                <span className="font-medium text-[var(--color-fg)]">
                  {filters.map((f) => `${kindLabel(f.kind)}: ${f.name}`).join(' · ')}
                </span>
              </p>

              <div
                ref={hostsListRef}
                className="mt-3 max-h-[min(60vh,28rem)] overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40"
              >
                <ul>
                  {sortedHosts.map((pc, idx) => {
                    const clickable = pc.id > 0
                    return (
                      <li
                        key={`${pc.id}-${pc.hostname}`}
                        className={idx > 0 ? 'border-t border-[var(--color-border)]' : undefined}
                      >
                        <div className="flex items-start gap-2 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-mono text-sm font-semibold text-[var(--color-fg)]">
                              {pc.hostname}
                            </div>
                            <div className="mt-0.5 truncate text-[11px] text-[var(--color-fg-subtle)]">
                              {[
                                pc.os_summary || pc.os_name,
                                pc.cpu,
                                pc.ram_gb != null ? `${pc.ram_gb} ГБ` : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </div>
                          {clickable ? (
                            <button
                              type="button"
                              onClick={() => setComputerId(pc.id)}
                              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-primary)] shadow-sm transition hover:border-[var(--color-primary)]/40 hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]"
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
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                {t('common.total')}: {hostsTotal}
                {hostsTotal > sortedHosts.length
                  ? ` · ${t('software.shownCount').replace('{count}', String(sortedHosts.length))}`
                  : null}
              </p>
            </>
          ) : (
            <p className="mt-4 text-sm text-[var(--color-fg-subtle)]">{t('software.noDataForSelection')}</p>
          )}
        </div>
      </div>

      {computerId != null ? (
        <ComputerDetailModal computerId={computerId} onClose={() => setComputerId(null)} />
      ) : null}
    </div>
  )
}
