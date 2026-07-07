import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api, type Computer, type TagBrief } from '../api'
import { ComputerDetailModal, fmtDate, tagPillProps } from '../components/ComputerDetailModal'
import { IconPcs } from '../components/icons'

const PC_COLUMN_DEFS = [
  { key: 'location', label: 'Локация' },
  { key: 'tags', label: 'Теги' },
  { key: 'os', label: 'ОС' },
  { key: 'ram', label: 'RAM' },
  { key: 'software', label: 'ПО' },
  { key: 'peripheral', label: 'Периферия' },
  { key: 'last', label: 'Последний отчёт' },
] as const

type PcColumnKey = (typeof PC_COLUMN_DEFS)[number]['key']

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
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState<Computer[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const columnsMenuRef = useRef<HTMLDivElement | null>(null)
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false)
  const [columns, setColumns] = useState<Record<PcColumnKey, boolean>>(readPcColumns)
  const [detailComputerId, setDetailComputerId] = useState<number | null>(null)
  const [allTags, setAllTags] = useState<TagBrief[]>([])
  const [hostSearch, setHostSearch] = useState('')
  const [debouncedHostSearch, setDebouncedHostSearch] = useState('')
  const [filterTagIds, setFilterTagIds] = useState<number[]>([])
  const [sort, setSort] = useState<{ key: 'host' | 'ram' | 'periph' | 'last'; dir: 'asc' | 'desc' }>({
    key: 'last',
    dir: 'desc',
  })

  const visibleColumnCount = useMemo(
    () => 1 + PC_COLUMN_DEFS.filter((c) => columns[c.key]).length,
    [columns],
  )

  useClickOutside(
    [columnsMenuRef],
    () => setColumnsMenuOpen(false),
    columnsMenuOpen,
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

  const sortedRows = useMemo(() => {
    const dirMul = sort.dir === 'asc' ? 1 : -1
    const copy = [...rows]
    copy.sort((a, b) => {
      if (sort.key === 'host') {
        return dirMul * a.hostname.localeCompare(b.hostname, 'ru', { sensitivity: 'base' })
      }
      if (sort.key === 'ram') {
        const av = a.ram_gb ?? -1
        const bv = b.ram_gb ?? -1
        return dirMul * (av - bv)
      }
      if (sort.key === 'periph') {
        return dirMul * (a.peripheral_count - b.peripheral_count)
      }
      // last report: nulls last in desc, first in asc
      const at = a.last_report_at ? Date.parse(a.last_report_at) : NaN
      const bt = b.last_report_at ? Date.parse(b.last_report_at) : NaN
      const aHas = Number.isFinite(at)
      const bHas = Number.isFinite(bt)
      if (aHas && bHas) return dirMul * (at - bt)
      if (aHas && !bHas) return -1 * dirMul
      if (!aHas && bHas) return 1 * dirMul
      return dirMul * a.hostname.localeCompare(b.hostname, 'ru', { sensitivity: 'base' })
    })
    return copy
  }, [rows, sort.dir, sort.key])

  function toggleSort(key: typeof sort.key) {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' }
      return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  function sortArrow(key: typeof sort.key) {
    if (sort.key !== key) return <span className="ml-1 text-slate-300">↕</span>
    return <span className="ml-1 text-slate-600">{sort.dir === 'asc' ? '↑' : '↓'}</span>
  }

  const load = useCallback(async () => {
    setErr(null)
    try {
      const data = await api.computers({
        q: debouncedHostSearch.trim() || undefined,
        tag_ids: filterTagIds.length ? filterTagIds : undefined,
        limit: 500,
      })
      setRows(data.items)
      setTotal(data.total)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [debouncedHostSearch, filterTagIds])

  useEffect(() => {
    void load()
  }, [load])

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
    const idRaw = searchParams.get('computer')
    if (!idRaw) return
    const id = Number.parseInt(idRaw, 10)
    if (!Number.isFinite(id) || id <= 0) return
    if (detailComputerId === id) return
    openDetail(id)
  }, [searchParams, detailComputerId])

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-center gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon shrink-0">
          <IconPcs className="h-6 w-6" />
        </div>
        <h1 className="page-title">Парк ПК</h1>
      </div>

      {err && (
        <div className="app-alert app-alert-error mb-4">
          {err}
        </div>
      )}

      <div className="mb-4 flex flex-col app-stack-3 app-radius-lg border border-slate-200/90 bg-white/90 p-4 shadow-sm sm:flex-row sm:flex-wrap sm:items-end sm:app-stack-4">
        <div className="min-w-[min(100%,18rem)] flex-1">
          <label htmlFor="pc-host-search" className="app-label">
            Имя хоста
          </label>
          <input
            id="pc-host-search"
            type="search"
            value={hostSearch}
            onChange={(e) => setHostSearch(e.target.value)}
            placeholder="Часть имени, например DESKTOP…"
            className="app-input"
          />
        </div>
        {allTags.length > 0 ? (
          <div className="min-w-0 flex-1">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Теги (любой из выбранных)</div>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((t) => {
                const on = filterTagIds.includes(t.id)
                const pill = tagPillProps(t)
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleFilterTag(t.id)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                      on
                        ? 'bg-red-600 text-white ring-2 ring-red-300 ring-offset-1'
                        : `${pill.className} opacity-90 hover:opacity-100`
                    }`}
                    style={on ? undefined : pill.style}
                  >
                    {t.name}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
        <div className="relative shrink-0 self-end" ref={columnsMenuRef}>
          <button
            type="button"
            className="app-btn app-btn-secondary gap-1.5"
            onClick={() => setColumnsMenuOpen((v) => !v)}
            aria-expanded={columnsMenuOpen}
            aria-haspopup="menu"
          >
            Вид таблицы
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
              className="popup-enter absolute right-0 top-[calc(100%+0.35rem)] z-30 w-52 overflow-hidden rounded-2xl border border-neutral-200 bg-white/98 p-2 shadow-[0_18px_40px_-18px_rgba(2,6,23,0.55)] backdrop-blur"
            >
              <p className="px-2 pb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">Столбцы</p>
              {PC_COLUMN_DEFS.map((col) => (
                <label
                  key={col.key}
                  className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-2 text-sm text-slate-700 transition hover:bg-neutral-50"
                >
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
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

      <div className="app-card overflow-hidden p-0 shadow-[0_4px_24px_-8px_rgb(15_23_42_/_0.12)]">
        <div className="-mx-0 overflow-x-auto overscroll-x-contain">
        <table className="min-w-[720px] w-full text-left text-sm">
          <thead className="app-table-head">
            <tr>
              <th className="px-4 py-3">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 hover:text-slate-600"
                  onClick={() => toggleSort('host')}
                  title="Сортировка по хосту"
                >
                  Хост {sortArrow('host')}
                </button>
              </th>
              {columns.location ? <th className="px-4 py-3">Локация</th> : null}
              {columns.tags ? <th className="px-4 py-3">Теги</th> : null}
              {columns.os ? <th className="px-4 py-3">ОС</th> : null}
              {columns.ram ? (
                <th className="px-4 py-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-slate-600"
                    onClick={() => toggleSort('ram')}
                    title="Сортировка по RAM"
                  >
                    RAM {sortArrow('ram')}
                  </button>
                </th>
              ) : null}
              {columns.software ? <th className="px-4 py-3">ПО</th> : null}
              {columns.peripheral ? (
                <th className="px-4 py-3" title="Периферия (PnP)">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-slate-600"
                    onClick={() => toggleSort('periph')}
                    title="Сортировка по периферии (кол-во)"
                  >
                    Периф. {sortArrow('periph')}
                  </button>
                </th>
              ) : null}
              {columns.last ? (
                <th className="px-4 py-3">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 hover:text-slate-600"
                    onClick={() => toggleSort('last')}
                    title="Сортировка по последнему отчёту"
                  >
                    Последний отчёт {sortArrow('last')}
                  </button>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {loading ? (
              <tr>
                <td colSpan={visibleColumnCount} className="px-4 py-8 text-center text-slate-500">
                  Загрузка…
                </td>
              </tr>
            ) : total === 0 ? (
              <tr>
                <td colSpan={visibleColumnCount} className="px-4 py-12 text-center text-slate-500">
                  Пока нет ПК. Запустите{' '}
                  <code className="rounded bg-slate-100 px-1 text-slate-700">inventory_send.bat</code>.
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={visibleColumnCount} className="px-4 py-12 text-center text-slate-500">
                  Нет ПК по текущим фильтрам. Измените поиск или снимите теги.
                </td>
              </tr>
            ) : (
              sortedRows.map((r) => (
                <tr
                  key={r.id}
                  className="app-table-row cursor-pointer"
                  onClick={() => openDetail(r.id)}
                >
                  <td className="px-4 py-3 font-medium text-slate-900">{r.hostname}</td>
                  {columns.location ? (
                    <td className="max-w-[8rem] truncate px-4 py-3 text-slate-600">{r.location ?? '—'}</td>
                  ) : null}
                  {columns.tags ? (
                    <td className="max-w-[11rem] px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {r.tags.length === 0 ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          r.tags.map((t) => {
                            const pill = tagPillProps(t)
                            return (
                              <span key={t.id} className={pill.className} style={pill.style}>
                                {t.name}
                              </span>
                            )
                          })
                        )}
                      </div>
                    </td>
                  ) : null}
                  {columns.os ? (
                    <td className="px-4 py-3 text-slate-600">
                      {r.os_name ?? '—'} {r.os_version ? `(${r.os_version})` : ''}
                    </td>
                  ) : null}
                  {columns.ram ? (
                    <td className="px-4 py-3 text-slate-600">
                      {r.ram_gb != null ? `${Math.round(r.ram_gb)} ГБ` : '—'}
                    </td>
                  ) : null}
                  {columns.software ? (
                    <td className="px-4 py-3 font-mono tabular-nums font-semibold text-neutral-900">
                      {r.software_count}
                    </td>
                  ) : null}
                  {columns.peripheral ? (
                    <td className="px-4 py-3 font-mono tabular-nums font-semibold text-neutral-900">
                      {r.peripheral_count}
                    </td>
                  ) : null}
                  {columns.last ? (
                    <td className="px-4 py-3 text-slate-500">{fmtDate(r.last_report_at)}</td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
        </div>
      </div>

      <ComputerDetailModal
        computerId={detailComputerId}
        onClose={closeDetail}
        onChanged={() => void load()}
      />
    </div>
  )
}
