import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type Computer, type TagBrief } from '../api'
import { ComputerDetailModal, fmtDate, tagPillProps } from '../components/ComputerDetailModal'
import { IconPcs } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { TableSkeleton } from '../components/Skeleton'
import { useComputerPingLive } from '../hooks/useComputerPingLive'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

const PC_COLUMN_KEYS = ['location', 'tags', 'os', 'ram', 'software', 'peripheral', 'last'] as const

type PcColumnKey = (typeof PC_COLUMN_KEYS)[number]

const LS_PC_COLUMNS = 'corax.pcs.columns.v1'

const DEFAULT_COLUMNS: Record<PcColumnKey, boolean> = {
  location: true,
  tags: true,
  os: true,
  ram: true,
  software: true,
  peripheral: true,
  last: true,
}

function readPcColumns(): Record<PcColumnKey, boolean> {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_COLUMNS }
  try {
    const raw = localStorage.getItem(LS_PC_COLUMNS)
    if (!raw) return { ...DEFAULT_COLUMNS }
    const parsed = JSON.parse(raw) as Partial<Record<PcColumnKey, boolean>>
    return { ...DEFAULT_COLUMNS, ...parsed }
  } catch {
    return { ...DEFAULT_COLUMNS }
  }
}

function useClickOutside(refs: Array<RefObject<HTMLElement | null>>, onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    function onDoc(e: MouseEvent) {
      const t = e.target as Node
      if (refs.some((r) => r.current?.contains(t))) return
      onClose()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [refs, onClose, enabled])
}

export function ComputersPage() {
  const t = useT()
  const PAGE_SIZE = 100
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState<Computer[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const toast = useToast()
  const columnsMenuRef = useRef<HTMLDivElement | null>(null)
  const tagsMenuRef = useRef<HTMLDivElement | null>(null)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  const [tagsMenuOpen, setTagsMenuOpen] = useState(false)
  const [columns, setColumns] = useState<Record<PcColumnKey, boolean>>(readPcColumns)
  const [detailComputerId, setDetailComputerId] = useState<number | null>(null)
  const [allTags, setAllTags] = useState<TagBrief[]>([])
  const [hostSearch, setHostSearch] = useState('')
  const [debouncedHostSearch, setDebouncedHostSearch] = useState('')
  const [filterTagIds, setFilterTagIds] = useState<number[]>([])
  const [pingFilter, setPingFilter] = useState<'all' | 'online' | 'offline' | 'unknown'>('all')
  const [sort, setSort] = useState<{ key: 'host' | 'ram' | 'periph' | 'last'; dir: 'asc' | 'desc' }>({
    key: 'last',
    dir: 'desc',
  })
  const [page, setPage] = useState(1)

  const pcColumnDefs = useMemo(
    () => [
      { key: 'location' as const, label: t('computers.columns.location') },
      { key: 'tags' as const, label: t('computers.columns.tags') },
      { key: 'os' as const, label: t('computers.columns.os') },
      { key: 'ram' as const, label: t('computers.columns.ram') },
      { key: 'software' as const, label: t('computers.columns.software') },
      { key: 'peripheral' as const, label: t('computers.columns.peripheral') },
      { key: 'last' as const, label: t('computers.columns.last') },
    ],
    [t],
  )

  const visibleColumnCount = useMemo(
    () => 1 + pcColumnDefs.filter((c) => columns[c.key]).length,
    [columns, pcColumnDefs],
  )

  useClickOutside(
    [columnsMenuRef, tagsMenuRef],
    () => {
      setColumnsMenuOpen(false)
      setTagsMenuOpen(false)
    },
    columnsMenuOpen || tagsMenuOpen,
  )

  function toggleColumn(key: PcColumnKey) {
    setColumns((prev) => {
      const next = { ...prev, [key]: !prev[key] }
      try {
        localStorage.setItem(LS_PC_COLUMNS, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedHostSearch(hostSearch), 350)
    return () => window.clearTimeout(t)
  }, [hostSearch])

  const filteredRows = useMemo(() => rows, [rows])
  const sortedRows = filteredRows

  const pageCount = useMemo(
    () => Math.max(1, Math.ceil(total / PAGE_SIZE)),
    [total, PAGE_SIZE],
  )

  const pagedRows = sortedRows

  useEffect(() => {
    setPage(1)
  }, [debouncedHostSearch, filterTagIds, pingFilter, sort.key, sort.dir])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  function toggleSort(key: typeof sort.key) {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' }
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  function sortArrow(key: typeof sort.key) {
    if (sort.key !== key) return <span className="ml-1 text-[var(--color-fg-subtle)]">↕</span>
    return <span className="ml-1 text-[var(--color-fg-muted)]">{sort.dir === 'asc' ? '↑' : '↓'}</span>
  }

  const applyPingMap = useCallback(
    (
      items: Computer[],
      pingItems: Array<{
        id: number
        ping_status: string | null
        last_ping_at: string | null
        ip_address: string | null
      }>,
    ) => {
      const map = new Map(pingItems.map((x) => [x.id, x]))
      return items.map((row) => {
        const s = map.get(row.id)
        if (!s) return row
        const nextStatus = (s.ping_status || '').toLowerCase() || null
        const prevStatus = (row.ping_status || '').toLowerCase() || null
        // Never downgrade a known online/offline to empty/unknown from a stale payload.
        const status =
          nextStatus === 'online' || nextStatus === 'offline'
            ? nextStatus
            : prevStatus === 'online' || prevStatus === 'offline'
              ? prevStatus
              : nextStatus
        return {
          ...row,
          ping_status: status,
          last_ping_at: s.last_ping_at ?? row.last_ping_at,
          ip_address: s.ip_address ?? row.ip_address,
        }
      })
    },
    [],
  )

  const load = useCallback(async () => {
    try {
      const [data, ping] = await Promise.all([
        api.computers({
          view: 'list',
          skip: (page - 1) * PAGE_SIZE,
          limit: PAGE_SIZE,
          q: debouncedHostSearch.trim() || undefined,
          tag_ids: filterTagIds.length ? filterTagIds : undefined,
          ping_status: pingFilter === 'all' ? undefined : pingFilter,
          sort: sort.key,
          sort_dir: sort.dir,
        }),
        api.computersPingStatus(false).catch(() => ({ items: [], sweep: null })),
      ])
      setRows(applyPingMap(data.items, ping.items))
      setTotal(data.total)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [
    PAGE_SIZE,
    applyPingMap,
    debouncedHostSearch,
    filterTagIds,
    page,
    pingFilter,
    sort.dir,
    sort.key,
    t,
    toast,
  ])

  useEffect(() => {
    void load()
  }, [load])

  // Live ping dots: poll cache + auto full-sweep while this page is open.
  useComputerPingLive({
    onItems: useCallback(
      (items) => {
        setRows((prev) => applyPingMap(prev, items))
      },
      [applyPingMap],
    ),
  })

  useEffect(() => {
    void api
      .tags()
      .then(setAllTags)
      .catch(() => setAllTags([]))
  }, [])

  function toggleFilterTag(id: number) {
    setFilterTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function openDetail(id: number) {
    setDetailComputerId(id)
  }

  function closeDetail() {
    setDetailComputerId(null)
    if (searchParams.has('computer')) {
      const next = new URLSearchParams(searchParams)
      next.delete('computer')
      setSearchParams(next, { replace: true })
    }
  }

  useEffect(() => {
    const ping = (searchParams.get('ping') || '').trim().toLowerCase()
    if (ping === 'online' || ping === 'offline' || ping === 'unknown') {
      setPingFilter(ping)
    }
  }, [searchParams])

  useEffect(() => {
    const idRaw = searchParams.get('computer')
    if (!idRaw) return
    const id = Number.parseInt(idRaw, 10)
    if (!Number.isFinite(id) || id <= 0) return
    if (detailComputerId === id) return
    openDetail(id)
  }, [searchParams, detailComputerId])

  return (
    <div>
      <PageHeader
        icon={<IconPcs className="h-6 w-6" />}
        title={t('titles.computers')}
        subtitle={t('pages.computersSubtitle')}
      />

      <div className="app-card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-3">
        <div className="min-w-[min(100%,18rem)] flex-1">
          <label htmlFor="pc-host-search" className="app-label">
            {t('computers.hostLabel')}
          </label>
          <input
            id="pc-host-search"
            type="search"
            value={hostSearch}
            onChange={(e) => setHostSearch(e.target.value)}
            placeholder={t('computers.hostPlaceholder')}
            className="app-input"
          />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="shrink-0">
            <span className="app-label">{t('computers.pingFilterLabel')}</span>
            <div
              className="mt-1 grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] sm:flex"
              role="group"
              aria-label={t('computers.pingFilterLabel')}
            >
              {(
                [
                  ['all', t('computers.pingFilterAll')],
                  ['online', t('computers.pingFilterOnline')],
                  ['offline', t('computers.pingFilterOffline')],
                  ['unknown', t('computers.pingFilterUnknown')],
                ] as const
              ).map(([key, label]) => {
                const on = pingFilter === key
                return (
                  <button
                    key={key}
                    type="button"
                    className={`inline-flex min-h-11 items-center justify-center gap-1.5 px-2.5 py-2 text-xs font-semibold transition sm:min-h-0 sm:justify-start sm:px-3 sm:text-sm ${
                      on
                        ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                        : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                    }`}
                    aria-pressed={on}
                    onClick={() => setPingFilter(key)}
                  >
                    {key !== 'all' ? (
                      <span
                        className={
                          key === 'online'
                            ? 'pc-ping-dot pc-ping-dot--online !h-2 !w-2'
                            : key === 'offline'
                              ? 'pc-ping-dot pc-ping-dot--offline !h-2 !w-2'
                              : 'pc-ping-dot pc-ping-dot--unknown !h-2 !w-2'
                        }
                        aria-hidden
                      />
                    ) : null}
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          {allTags.length > 0 ? (
            <div className="relative shrink-0" ref={tagsMenuRef}>
              <button
                type="button"
                className={`app-btn app-btn-secondary gap-1.5`}
                onClick={() => {
                  setTagsMenuOpen((v) => !v)
                  setColumnsMenuOpen(false)
                }}
                aria-expanded={tagsMenuOpen}
                aria-haspopup="menu"
                title={t('computers.tagsFilterOpen')}
              >
                {t('computers.tagsFilter')}
                {filterTagIds.length > 0 ? (
                  <span className="rounded-md bg-[var(--color-primary-muted)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)]">
                    {filterTagIds.length}
                  </span>
                ) : null}
                <svg
                  viewBox="0 0 20 20"
                  className={`h-3.5 w-3.5 opacity-50 transition ${tagsMenuOpen ? 'rotate-180' : ''}`}
                  fill="currentColor"
                  aria-hidden
                >
                  <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.25a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08Z" />
                </svg>
              </button>
              {tagsMenuOpen ? (
                <div
                  role="menu"
                  className="popup-enter absolute left-0 top-[calc(100%+0.35rem)] z-30 w-[min(20rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-card)] sm:left-auto sm:right-0"
                >
                  <div className="mb-1.5 flex items-center justify-between gap-2 px-2">
                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                      {t('computers.tagsAnySelected')}
                    </p>
                    {filterTagIds.length > 0 ? (
                      <button
                        type="button"
                        className="text-[11px] font-semibold text-[var(--color-primary)] hover:underline"
                        onClick={() => setFilterTagIds([])}
                      >
                        {t('computers.tagsClear')}
                      </button>
                    ) : null}
                  </div>
                  <div className="max-h-56 space-y-0.5 overflow-y-auto">
                    {allTags.map((tag) => {
                      const on = filterTagIds.includes(tag.id)
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={on}
                          onClick={() => toggleFilterTag(tag.id)}
                          className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left text-sm transition hover:bg-[var(--color-surface-muted)] ${
                            on ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]' : 'text-[var(--color-fg)]'
                          }`}
                        >
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border-strong)]'}`}
                            aria-hidden
                          />
                          <span className="min-w-0 truncate">{tag.name}</span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="relative shrink-0" ref={columnsMenuRef}>
            <button
              type="button"
              className="app-btn app-btn-secondary gap-1.5"
              onClick={() => {
                setColumnsMenuOpen((v) => !v)
                setTagsMenuOpen(false)
              }}
              aria-expanded={columnsMenuOpen}
              aria-haspopup="menu"
            >
              {t('computers.tableView')}
              <svg
                viewBox="0 0 20 20"
                className={`h-3.5 w-3.5 opacity-50 transition ${columnsMenuOpen ? 'rotate-180' : ''}`}
                fill="currentColor"
                aria-hidden
              >
                <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.25a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08Z" />
              </svg>
            </button>
            {columnsMenuOpen ? (
              <div
                role="menu"
                className="popup-enter absolute right-0 top-[calc(100%+0.35rem)] z-30 w-52 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-[var(--shadow-card)]"
              >
                <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                  {t('computers.columnsTitle')}
                </p>
                {pcColumnDefs.map((col) => (
                  <label
                    key={col.key}
                    className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-[var(--color-border)]"
                      checked={columns[col.key]}
                      onChange={() => toggleColumn(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div
        key={`pcs-${pingFilter}-${debouncedHostSearch}-${filterTagIds.join(',')}-${sort.key}-${sort.dir}`}
        className="app-card app-fade-swap overflow-hidden p-0"
      >
        <div className="-mx-0 overflow-x-auto overscroll-x-contain">
        <table className="min-w-[720px] w-full max-sm:min-w-[28rem] text-left text-sm">
          <thead className="app-table-head">
            <tr>
              <th className="app-table-sticky-col px-4 py-3">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
                  onClick={() => toggleSort('host')}
                  title={t('computers.sortByHost')}
                >
                  {t('computers.columns.host')} {sortArrow('host')}
                </button>
              </th>
              {columns.location ? <th className="app-hide-xs px-4 py-3">{t('computers.columns.location')}</th> : null}
              {columns.tags ? <th className="px-4 py-3">{t('computers.columns.tags')}</th> : null}
              {columns.os ? <th className="app-hide-xs px-4 py-3">{t('computers.columns.os')}</th> : null}
              {columns.ram ? (
                <th className="px-4 py-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
                    onClick={() => toggleSort('ram')}
                    title={t('computers.sortByRam')}
                  >
                    {t('computers.columns.ram')} {sortArrow('ram')}
                  </button>
                </th>
              ) : null}
              {columns.software ? <th className="px-4 py-3">{t('computers.columns.software')}</th> : null}
              {columns.peripheral ? (
                <th className="px-4 py-3" title={t('computers.peripheralTitle')}>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
                    onClick={() => toggleSort('periph')}
                    title={t('computers.sortByPeripheral')}
                  >
                    {t('computers.columns.peripheralShort')} {sortArrow('periph')}
                  </button>
                </th>
              ) : null}
              {columns.last ? (
                <th className="px-4 py-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
                    onClick={() => toggleSort('last')}
                    title={t('computers.sortByLastReport')}
                  >
                    {t('computers.columns.last')} {sortArrow('last')}
                  </button>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={visibleColumnCount} className="p-0">
                  <TableSkeleton rows={8} cols={Math.min(visibleColumnCount, 6)} />
                </td>
              </tr>
            ) : total === 0 ? (
              <tr>
                <td colSpan={visibleColumnCount} className="px-4 py-12 text-center text-[var(--color-fg-muted)]">
                  {t('computers.noComputersBeforeCommand')}{' '}
                  <code className="rounded bg-[var(--color-surface-muted)] px-1 text-[var(--color-fg)]">inventory_send.bat</code>.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumnCount} className="px-4 py-12 text-center text-[var(--color-fg-muted)]">
                  {t('computers.noMatches')}
                </td>
              </tr>
            ) : (
              pagedRows.map((r, idx) => (
                <tr
                  key={r.id}
                  className={`app-table-row cursor-pointer ${idx > 0 ? 'border-t border-[var(--color-border)]' : ''}`}
                  onClick={() => openDetail(r.id)}
                >
                  <td className="app-table-sticky-col px-4 py-3 font-medium text-[var(--color-fg)]">
                    <span className="inline-flex min-w-0 items-center gap-2.5">
                      <span
                        className={
                          (r.ping_status || '').toLowerCase() === 'online'
                            ? 'pc-ping-dot pc-ping-dot--online'
                            : (r.ping_status || '').toLowerCase() === 'offline'
                              ? 'pc-ping-dot pc-ping-dot--offline'
                              : 'pc-ping-dot pc-ping-dot--unknown'
                        }
                        title={
                          (r.ping_status || '').toLowerCase() === 'online'
                            ? t('computers.pingOnline')
                            : (r.ping_status || '').toLowerCase() === 'offline'
                              ? t('computers.pingOffline')
                              : t('computers.pingUnknown')
                        }
                        aria-label={
                          (r.ping_status || '').toLowerCase() === 'online'
                            ? t('computers.pingOnline')
                            : (r.ping_status || '').toLowerCase() === 'offline'
                              ? t('computers.pingOffline')
                              : t('computers.pingUnknown')
                        }
                      />
                      <span className="min-w-0 truncate">{r.hostname}</span>
                    </span>
                  </td>
                  {columns.location ? (
                    <td className="app-hide-xs max-w-[8rem] truncate px-4 py-3 text-[var(--color-fg-muted)]">{r.location ?? '—'}</td>
                  ) : null}
                  {columns.tags ? (
                    <td className="max-w-[11rem] px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {r.tags.length === 0 ? (
                          <span className="text-[var(--color-fg-subtle)]">—</span>
                        ) : (
                          r.tags.map((tag) => {
                            const pill = tagPillProps(tag)
                            return (
                              <span key={tag.id} className={pill.className} style={pill.style}>
                                {tag.name}
                              </span>
                            )
                          })
                        )}
                      </div>
                    </td>
                  ) : null}
                  {columns.os ? (
                    <td className="app-hide-xs px-4 py-3 text-[var(--color-fg-muted)]">
                      {r.os_name ?? '—'} {r.os_version ? `(${r.os_version})` : ''}
                    </td>
                  ) : null}
                  {columns.ram ? (
                    <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                      {r.ram_gb != null ? t('computers.ramValue', { value: Math.round(r.ram_gb) }) : '—'}
                    </td>
                  ) : null}
                  {columns.software ? (
                    <td className="px-4 py-3 font-mono tabular-nums font-semibold text-[var(--color-fg)]">
                      {r.software_count}
                    </td>
                  ) : null}
                  {columns.peripheral ? (
                    <td className="px-4 py-3 font-mono tabular-nums font-semibold text-[var(--color-fg)]">
                      {r.peripheral_count}
                    </td>
                  ) : null}
                  {columns.last ? (
                    <td className="px-4 py-3 text-[var(--color-fg-subtle)]">{fmtDate(r.last_report_at, 'ru')}</td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      {!loading && total > PAGE_SIZE ? (
        <div className="mt-3 flex flex-col gap-2 text-sm text-[var(--color-fg-muted)] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span>
            {t('computers.shownOf', { shown: pagedRows.length, total })}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="app-btn app-btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              {t('common.back')}
            </button>
            <span className="text-xs font-medium">
              {t('computers.pageOf', { page: Math.min(page, pageCount), count: pageCount })}
            </span>
            <button
              type="button"
              className="app-btn app-btn-secondary min-h-11 px-3 py-1.5 text-xs sm:min-h-0"
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
              disabled={page >= pageCount}
            >
              {t('computers.next')}
            </button>
          </div>
        </div>
      ) : null}

      <ComputerDetailModal
        computerId={detailComputerId}
        preview={detailComputerId != null ? rows.find((r) => r.id === detailComputerId) ?? null : null}
        onClose={closeDetail}
        onChanged={() => void load()}
      />
    </div>
  )
}
