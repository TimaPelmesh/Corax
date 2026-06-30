import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type CatalogKind, type SoftwareCatalogRow } from '../api'
import { IconSoftware } from '../components/icons'

const CATALOG_SECTIONS: Array<{ kind: CatalogKind; label: string }> = [
  { kind: 'software', label: 'ПО' },
  { kind: 'peripheral', label: 'Устройства' },
  { kind: 'cpu', label: 'Процессоры' },
  { kind: 'os', label: 'ОС' },
  { kind: 'manufacturer', label: 'Производители' },
]

export function SoftwarePage() {
  const [kind, setKind] = useState<CatalogKind>('software')
  const [query, setQuery] = useState('')
  const [rows, setRows] = useState<SoftwareCatalogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hosts, setHosts] = useState<string[] | null>(null)
  const [hostsLoading, setHostsLoading] = useState(false)
  const hostsPanelRef = useRef<HTMLDivElement>(null)
  const hostsListRef = useRef<HTMLUListElement>(null)

  const load = useCallback(async (nextKind: CatalogKind, q: string) => {
    setErr(null)
    setLoading(true)
    try {
      setRows(await api.catalog(nextKind, q.trim() || undefined))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

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
      setErr(e instanceof Error ? e.message : 'Ошибка')
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
      <div className="mb-6 flex min-w-0 items-center gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon shrink-0">
          <IconSoftware className="h-6 w-6" />
        </div>
        <h1 className="page-title">Каталог</h1>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
          {err}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-wrap gap-2">
          {CATALOG_SECTIONS.map((s) => (
            <button
              key={s.kind}
              type="button"
              onClick={() => setKind(s.kind)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                kind === s.kind
                  ? 'border-zinc-600 bg-zinc-700 text-white shadow'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-slate-400 hover:bg-slate-50'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="sw-search">
          Поиск
        </label>
        <input
          id="sw-search"
          type="search"
          placeholder="Начните вводить для фильтра…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="app-input app-input--lg min-w-[min(100%,24rem)] flex-1 shadow-sm"
        />
        {loading ? <span className="text-sm text-slate-500">Обновление…</span> : null}
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <div className="app-card overflow-hidden p-0 lg:col-span-3">
          <div className="-mx-0 overflow-x-auto overscroll-x-contain">
          <table className="min-w-[min(100%,20rem)] w-full text-left text-[13px]">
            <thead className="app-table-head !text-[10px]">
              <tr>
                <th className="px-4 py-2.5">Название</th>
                <th className="px-4 py-2.5 text-right">ПК</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {rows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={2} className="px-4 py-12 text-center text-slate-500">
                    Ничего не найдено. Уточните запрос или отправьте отчёты агента.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={r.name}
                    className={`cursor-pointer ${selected === r.name ? 'bg-neutral-50 ring-2 ring-inset ring-neutral-200/80' : 'app-table-row'}`}
                    onClick={() => void pickRow(r.name)}
                  >
                    <td className="px-4 py-2 text-slate-800" title={r.version ? `${r.name} — ${r.version}` : r.name}>
                      <div className="font-medium leading-snug">{r.name}</div>
                      {r.version ? (
                        <div className="mt-0.5 font-mono text-[11px] font-normal text-neutral-400">{r.version}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-[12px] tabular-nums font-semibold text-neutral-900">
                      {r.count}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          </div>
        </div>

        <div
          ref={hostsPanelRef}
          className="app-card p-4 sm:p-6 lg:col-span-2 lg:sticky lg:top-4 lg:z-10 lg:max-h-[calc(100dvh-5.5rem)] lg:overflow-y-auto lg:overscroll-contain"
        >
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">У кого установлено</h2>
          {!selected ? (
            <p className="mt-4 text-sm text-slate-500">Выберите строку в таблице слева.</p>
          ) : hostsLoading ? (
            <p className="mt-4 text-sm text-slate-500">Загрузка списка ПК…</p>
          ) : hosts && hosts.length ? (
            <>
              <p className="mt-2 text-xs text-slate-500">
                Точное имя пакета: <span className="font-medium text-slate-700">{selected}</span>
              </p>
              <ul
                ref={hostsListRef}
                className="mt-4 max-h-[min(60vh,28rem)] space-y-1 overflow-auto rounded-xl border border-slate-200/70 bg-slate-50/90 p-3 text-sm ring-1 ring-slate-100/90"
              >
                {hosts.map((h) => (
                  <li key={h} className="font-mono text-slate-800">
                    {h}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">Всего: {hosts.length}</p>
            </>
          ) : (
            <p className="mt-4 text-sm text-slate-500">Нет данных по выбранному названию.</p>
          )}
        </div>
      </div>
    </div>
  )
}
