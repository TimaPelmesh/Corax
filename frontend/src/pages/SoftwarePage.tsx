import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type CatalogKind, type SoftwareCatalogRow } from '../api'
import { IconSoftware } from '../components/icons'
import { TableSkeleton } from '../components/Skeleton'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function SoftwarePage() {
  const t = useT()
  const toast = useToast()
  const [kind, setKind] = useState<CatalogKind>('software')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SoftwareCatalogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [hosts, setHosts] = useState<string[] | null>(null)
  const [hostsLoading, setHostsLoading] = useState(false)
  const hostsPanelRef = useRef<HTMLDivElement>(null)
  const hostsListRef = useRef<HTMLUListElement>(null)

  const catalogSections = useMemo<Array<{ kind: CatalogKind; label: string }>>(
    () => [
      { kind: 'software', label: t('software.kinds.software') },
      { kind: 'peripheral', label: t('software.kinds.peripheral') },
      { kind: 'cpu', label: t('software.kinds.cpu') },
      { kind: 'os', label: t('software.kinds.os') },
      { kind: 'manufacturer', label: t('software.kinds.manufacturer') },
    ],
    [t],
  )

  const load = useCallback(async (nextKind: CatalogKind, q: string) => {
    setLoading(true)
    try {
      setRows(await api.catalog(nextKind, q.trim() || undefined))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    const t = window.setTimeout(() => {
      void load(kind, query)
    }, 320)
    return () => window.clearTimeout(t)
  }, [kind, query, load])

  useEffect(() => {
    setSelected(null)
    setHosts(null)
    setHostsLoading(false)
  }, [kind])

  async function pickRow(name: string) {
    setSelected(name)
    setHosts(null)
    setHostsLoading(true)
    try {
      const r = await api.catalogHosts(kind, name)
      setHosts(r.hostnames)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
      setHosts([])
    } finally {
      setHostsLoading(false)
    }
  }

  useEffect(() => {
    if (hostsLoading || hosts === null) return
    if (hostsListRef.current) {
      hostsListRef.current.scrollTop = 0
    }
    hostsPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [hosts, hostsLoading, selected])

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconSoftware className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <h1 className="page-title">{t('titles.software')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">{t('pages.softwareSubtitle')}</p>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {catalogSections.map((s) => (
            <button
              key={s.kind}
              type="button"
              onClick={() => setKind(s.kind)}
              className={`app-chip ${kind === s.kind ? 'app-chip--active' : ''}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="sw-search">
          {t('common.search')}
        </label>
        <input
          id="sw-search"
          type="search"
          placeholder={t('software.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="app-input app-input--lg min-w-[min(100%,24rem)] flex-1"
        />
        {loading ? <span className="text-sm text-[var(--color-fg-subtle)]">{t('software.refreshing')}</span> : null}
      </div>

      <div key={`sw-${kind}`} className="app-fade-swap grid items-start gap-6 lg:grid-cols-5">
        <div className="app-card overflow-hidden !p-0 lg:col-span-3">
          <div className="-mx-0 overflow-x-auto overscroll-x-contain">
            <table className="app-table min-w-[min(100%,20rem)]">
              <thead className="app-table-head !text-[10px]">
                <tr>
                  <th className="px-4 py-2.5">{t('software.columns.name')}</th>
                  <th className="px-4 py-2.5 text-right">{t('software.columns.pcs')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={2} className="app-table-cell py-12 text-center app-table-cell-muted">
                      <p>{query.trim() ? t('software.emptySearch') : t('software.empty')}</p>
                      {query.trim() ? (
                        <button
                          type="button"
                          className="app-btn app-btn-secondary mt-3 text-xs"
                          onClick={() => setQuery('')}
                        >
                          {t('software.clearSearch')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ) : loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="p-0">
                      <TableSkeleton rows={8} cols={2} />
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr
                      key={r.name}
                      className={`cursor-pointer ${selected === r.name ? 'app-table-row-selected' : 'app-table-row hover:bg-[var(--color-surface-muted)]'}`}
                      onClick={() => void pickRow(r.name)}
                    >
                      <td className="app-table-cell" title={r.version ? `${r.name} — ${r.version}` : r.name}>
                        <div className="font-medium leading-snug">{r.name}</div>
                        {r.version ? (
                          <div className="mt-0.5 font-mono text-[11px] font-normal app-table-cell-muted">{r.version}</div>
                        ) : null}
                      </td>
                      <td className="app-table-cell app-table-cell-num">{r.count}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div
          ref={hostsPanelRef}
          className="app-panel lg:col-span-2 lg:sticky lg:top-4 lg:z-10 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:overscroll-contain"
        >
          <h2 className="app-side-panel-title">{t('software.installedOnTitle')}</h2>
          {!selected ? (
            <p className="app-side-panel-muted mt-4">{t('software.selectRowHint')}</p>
          ) : hostsLoading ? (
            <p className="app-side-panel-muted mt-4">{t('software.loadingHosts')}</p>
          ) : hosts && hosts.length ? (
            <>
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                {t('software.exactPackageName')} <span className="font-medium text-[var(--color-fg)]">{selected}</span>
              </p>
              <ul ref={hostsListRef} className="app-host-list space-y-1">
                {hosts.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">
                {t('common.total')}: {hosts.length}
              </p>
            </>
          ) : (
            <p className="app-side-panel-muted mt-4">{t('software.noDataForSelection')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
