import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type NetworkPrinter,
  type PrinterPollConfig,
  type PrinterSchedulerStatus,
  type PrinterSupply,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconClose, IconPrinter } from '../components/icons'

type FilterChip = 'all' | 'offline' | 'low_toner' | 'snmp_error'

function fmtWhen(iso: string | null | undefined) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function displayTitle(row: NetworkPrinter) {
  const model = row.snmp_model?.trim()
  const name = row.name?.trim() || ''
  if (model) return model
  return name || row.ip_address || 'Принтер'
}

function formatSchedulerLine(sched: PrinterSchedulerStatus | null): string | null {
  if (!sched?.poll_enabled) return null
  const parts = [`Планировщик SNMP: каждые ${sched.poll_interval_minutes} мин`]
  if (sched.running_now) parts.push('идёт опрос…')
  if (sched.last_run_at) parts.push(`последний: ${fmtWhen(sched.last_run_at)}`)
  const summary = sched.last_run_summary?.message?.trim()
  if (summary) parts.push(summary)
  return parts.join(' · ')
}

function PrinterToast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="toast-enter-left fixed bottom-6 left-6 z-[100] flex max-w-[min(24rem,calc(100vw-3rem))] items-start gap-3 rounded-xl border border-neutral-200/90 bg-white px-4 py-3 text-sm font-medium leading-snug text-neutral-950 shadow-[0_18px_40px_-16px_rgb(15_23_42/0.45)]"
    >
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
      <span className="min-w-0 flex-1 whitespace-pre-line">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
        aria-label="Закрыть"
      >
        <IconClose className="h-4 w-4" />
      </button>
    </div>
  )
}

function supplyBarColor(pct: number | null) {
  if (pct == null) return 'bg-slate-300'
  if (pct <= 10) return 'bg-red-600'
  if (pct <= 25) return 'bg-amber-500'
  return 'bg-emerald-500'
}

/** Тонер/картридж — цветная метка; остальное из SNMP (печка, фильтр, developer…) — сервис, без «цвета тонера». */
function isTonerSupply(name: string): boolean {
  const s = name.toLowerCase()
  if (
    /(?:imaging unit|imageur|drum|фотобарабан|барабан|photoconductor)/i.test(s) ||
    /(?:fuser|fusing|печь|fuse)/i.test(s) ||
    /(?:filter|фильтр|ozone|озон|paper dust|remover|waste|бункер|отработ)/i.test(s) ||
    /(?:developer|transfer|belt|kit|maintenance)/i.test(s)
  ) {
    return false
  }
  return /(?:toner|cartridge|тонер|картридж|черн|cyan|magenta|yellow|голуб|жёлт|желт|пурпур|\bcf\d{3}|\bce40)/i.test(
    s,
  )
}

function partitionSupplies(supplies: PrinterSupply[]) {
  const toners: PrinterSupply[] = []
  const service: PrinterSupply[] = []
  for (const s of supplies) {
    if (isTonerSupply(s.name)) toners.push(s)
    else service.push(s)
  }
  const byName = (a: PrinterSupply, b: PrinterSupply) => a.name.localeCompare(b.name, 'ru')
  const tonerOrder = (name: string) => {
    const s = name.toLowerCase()
    if (/black|черн|ce400|cf410|cf226/i.test(s)) return 0
    if (/cyan|голуб|ce401|cf411/i.test(s)) return 1
    if (/magenta|пурпур|ce403|cf413/i.test(s)) return 2
    if (/yellow|жёлт|желт|ce402|cf412/i.test(s)) return 3
    return 4
  }
  toners.sort((a, b) => tonerOrder(a.name) - tonerOrder(b.name) || byName(a, b))
  service.sort(byName)
  return { toners, service }
}

function supplyTone(name: string): { dot: string; text: string; track: string; fill: string } {
  const s = name.toLowerCase()
  if (/(cyan|голуб|ce401a|cf411)/i.test(s)) {
    return { dot: 'bg-cyan-500', text: 'text-cyan-700', track: 'bg-cyan-50', fill: 'bg-cyan-500' }
  }
  if (/(magenta|пурпур|маджент|ce403a|cf413)/i.test(s)) {
    return { dot: 'bg-fuchsia-500', text: 'text-fuchsia-700', track: 'bg-fuchsia-50', fill: 'bg-fuchsia-500' }
  }
  if (/(yellow|желт|жёлт|ce402a|cf412)/i.test(s)) {
    return { dot: 'bg-yellow-400', text: 'text-yellow-700', track: 'bg-yellow-50', fill: 'bg-yellow-400' }
  }
  if (/(black|ч[её]рн|carbon|ce400a|ce400x|cf410|cf226)/i.test(s)) {
    return { dot: 'bg-slate-950', text: 'text-slate-950', track: 'bg-slate-100', fill: 'bg-slate-900' }
  }
  return { dot: 'bg-slate-400', text: 'text-slate-600', track: 'bg-slate-100', fill: 'bg-slate-400' }
}

const SERVICE_TONE = {
  dot: 'bg-slate-300',
  text: 'text-slate-600',
  track: 'bg-slate-100',
  fill: 'bg-slate-400',
} as const

function hasLowToner(supplies: PrinterSupply[] | undefined) {
  return (supplies ?? []).some(
    (s) => isTonerSupply(s.name) && s.level_percent != null && s.level_percent <= 15,
  )
}

function SupplyChip({
  s,
  colored,
}: {
  s: PrinterSupply
  colored: boolean
}) {
  const low = s.level_percent != null && s.level_percent <= 15
  const tone = colored ? supplyTone(s.name) : SERVICE_TONE
  return (
    <div
      key={s.name}
      className={colored ? 'min-w-[4.5rem] max-w-[8.5rem]' : 'min-w-[5rem] max-w-[9rem]'}
      title={s.name}
    >
      <div
        className={`flex items-center gap-1 text-[10px] ${low && colored ? 'font-semibold text-red-700' : 'font-medium text-slate-600'}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-black/10 ${tone.dot}`} />
        <span className={`min-w-0 truncate ${tone.text}`}>{s.name}</span>
        <span className="shrink-0 font-mono tabular-nums">
          {s.level_percent != null ? `${s.level_percent}%` : '?'}
        </span>
      </div>
      <div className={`mt-0.5 h-1 w-full overflow-hidden rounded-full ${tone.track}`}>
        <div
          className={`h-full rounded-full ${low && colored ? supplyBarColor(s.level_percent) : tone.fill}`}
          style={{ width: `${Math.max(4, s.level_percent ?? 0)}%` }}
        />
      </div>
    </div>
  )
}

function SuppliesCell({ supplies }: { supplies: PrinterSupply[] }) {
  if (!supplies.length) {
    return <span className="text-xs text-slate-400">—</span>
  }
  const { toners, service } = partitionSupplies(supplies)
  return (
    <div className="min-w-[10rem] space-y-1.5" title="SNMP: отдельные счётчики тонера, барабана, печки и фильтров — не дубли">
      {toners.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {toners.map((s) => (
            <SupplyChip key={s.name} s={s} colored />
          ))}
        </div>
      ) : null}
      {service.length > 0 ? (
        <div className="border-t border-dashed border-slate-200/90 pt-1.5">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Сервис</div>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {service.map((s) => (
              <SupplyChip key={s.name} s={s} colored={false} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

const FILTER_LABELS: Record<FilterChip, string> = {
  all: 'Все',
  offline: 'Offline',
  low_toner: 'Мало тонера',
  snmp_error: 'SNMP ошибка',
}

type DeleteTarget = {
  ids: number[]
  labels: string[]
}

export function PrintersPage() {
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')

  const [rows, setRows] = useState<NetworkPrinter[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterChip>('all')
  const [pollBusy, setPollBusy] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIp, setAddIp] = useState('')
  const [addLocation, setAddLocation] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfg, setCfg] = useState<PrinterPollConfig | null>(null)
  const [sched, setSched] = useState<PrinterSchedulerStatus | null>(null)
  const [cfgBusy, setCfgBusy] = useState(false)

  const reload = useCallback(async (q: string) => {
    setErr(null)
    const data = await api.printers({ q: q.trim() || undefined, limit: 3000 })
    setRows(data)
    setSelected(new Set())
  }, [])

  const reloadMeta = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.printerPollConfig(), api.printerSchedulerStatus()])
      setCfg(c)
      setSched(s)
    } catch {
      /* optional */
    }
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        await Promise.all([reload(search), reloadMeta()])
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
      } finally {
        setLoading(false)
      }
    })()
  }, [reload, reloadMeta, search])

  useEffect(() => {
    if (!canEdit) return
    const t = window.setInterval(() => void reloadMeta(), 30_000)
    return () => window.clearInterval(t)
  }, [canEdit, reloadMeta])

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 10_000)
    return () => window.clearTimeout(t)
  }, [toast])

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'offline') return r.poll_status === 'offline'
      if (filter === 'low_toner') return hasLowToner(r.supplies)
      if (filter === 'snmp_error') return r.snmp_status === 'error'
      return true
    })
  }, [rows, filter])

  const stats = useMemo(() => {
    const lowToner = rows.filter((r) => hasLowToner(r.supplies))
    return {
      total: rows.length,
      online: rows.filter((r) => r.poll_status === 'online').length,
      offline: rows.filter((r) => r.poll_status === 'offline').length,
      snmpOk: rows.filter((r) => r.snmp_status === 'ok').length,
      lowToner: lowToner.length,
    }
  }, [rows])

  const allVisibleSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selected.has(r.id))

  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      setSelected(new Set())
      return
    }
    setSelected(new Set(filteredRows.map((r) => r.id)))
  }

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const pollAll = async () => {
    if (!canEdit) return
    setPollBusy(true)
    setErr(null)
    try {
      const r = await api.pollAllPrinters()
      await Promise.all([reload(search), reloadMeta()])
      setToast(r.message?.trim() || 'Поиск и опрос завершены')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка опроса')
    } finally {
      setPollBusy(false)
    }
  }

  const pollBusyLabel =
    pollBusy || sched?.running_now ? 'Поиск и опрос…' : 'Найти и опросить'

  const pollOne = async (row: NetworkPrinter) => {
    if (!canEdit || !row.ip_address) return
    try {
      await api.pollPrinter(row.id)
      await reload(search)
      setToast(`SNMP обновлён: ${displayTitle(row)}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка опроса')
    }
  }

  const runCleanup = async () => {
    if (!canEdit) return
    setCleanupBusy(true)
    setErr(null)
    try {
      const r = await api.cleanupPrinters()
      await reload(search)
      setToast(
        `Очистка: удалено дубликатов ${r.deleted_duplicates}, мусора ${r.deleted_noise}, без IP ${r.deleted_no_ip}. Осталось ${r.remaining}.`,
      )
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка очистки')
    } finally {
      setCleanupBusy(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget || !canEdit) return
    setDeleteBusy(true)
    try {
      if (deleteTarget.ids.length === 1) {
        await api.deletePrinter(deleteTarget.ids[0])
      } else {
        await api.bulkDeletePrinters(deleteTarget.ids)
      }
      setDeleteTarget(null)
      await reload(search)
      setToast(`Удалено: ${deleteTarget.ids.length}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка удаления')
    } finally {
      setDeleteBusy(false)
    }
  }

  const saveConfig = async () => {
    if (!canEdit || !cfg) return
    setCfgBusy(true)
    try {
      const saved = await api.updatePrinterPollConfig({
        poll_enabled: cfg.poll_enabled,
        poll_interval_minutes: cfg.poll_interval_minutes,
        snmp_enabled: cfg.snmp_enabled,
        snmp_community: cfg.snmp_community,
        snmp_timeout_seconds: cfg.snmp_timeout_seconds,
        ping_timeout_ms: cfg.ping_timeout_ms,
        poll_concurrency: cfg.poll_concurrency,
      })
      setCfg(saved)
      await reloadMeta()
      setToast('Настройки опроса сохранены')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка сохранения')
    } finally {
      setCfgBusy(false)
    }
  }

  const submitAdd = async () => {
    if (!canEdit) return
    const name = addName.trim()
    const ip = addIp.trim()
    if (!name || !ip) return
    setAddBusy(true)
    try {
      await api.createPrinter({
        name,
        ip_address: ip,
        location: addLocation.trim() || null,
      })
      setAddOpen(false)
      setAddName('')
      setAddIp('')
      setAddLocation('')
      await reload(search)
      setToast('Принтер добавлен — запустите SNMP-опрос')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось добавить')
    } finally {
      setAddBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:mb-8 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex min-w-0 items-start gap-3 sm:gap-4">
          <div className="page-hero-icon mt-0.5">
            <IconPrinter className="h-6 w-6" />
          </div>
          <div>
            <h1 className="page-title">Принтеры</h1>
            <p className="mt-0.5 text-sm text-slate-500">
              Поиск по SNMP в локальных подсетях и опрос: модель, счётчик, расходники (в т.ч. Toshiba TEC, HP, Konica).
            </p>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <div className="inline-flex flex-wrap items-center gap-1.5 rounded-full border border-slate-200/75 bg-white/70 px-4 py-2 text-sm font-medium text-slate-600 shadow-[0_1px_3px_rgb(15_23_42_/_0.06)] backdrop-blur-sm">
            Всего:{' '}
            <span className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-sm font-semibold text-neutral-900">
              {stats.total}
            </span>
          </div>
          {canEdit ? (
            <>
              <button type="button" onClick={() => void runCleanup()} disabled={cleanupBusy} className="app-btn app-btn-secondary">
                {cleanupBusy ? 'Очистка…' : 'Очистить дубликаты'}
              </button>
              <button type="button" onClick={() => setCfgOpen(true)} className="app-btn app-btn-secondary">
                Настройки SNMP
              </button>
              <button
                type="button"
                onClick={() => void pollAll()}
                disabled={pollBusy || sched?.running_now}
                className="app-btn app-btn-primary"
              >
                {pollBusyLabel}
              </button>
              <button type="button" onClick={() => setAddOpen(true)} className="app-btn app-btn-secondary">
                + Добавить вручную
              </button>
              {selected.size > 0 ? (
                <button
                  type="button"
                  className="app-btn app-btn-danger"
                  onClick={() =>
                    setDeleteTarget({
                      ids: [...selected],
                      labels: rows.filter((r) => selected.has(r.id)).map((r) => displayTitle(r)),
                    })
                  }
                >
                  Удалить ({selected.size})
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {toast ? <PrinterToast message={toast} onDismiss={() => setToast(null)} /> : null}

      {err ? <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div> : null}

      {formatSchedulerLine(sched) ? (
        <div className="mb-4 rounded-xl border border-slate-200/90 bg-slate-50/80 px-3 py-2 text-xs leading-relaxed text-slate-600">
          {formatSchedulerLine(sched)}
        </div>
      ) : null}

      {pollBusy ? (
        <div className="mb-4 rounded-xl border border-sky-200/90 bg-sky-50/90 px-3 py-2 text-sm text-sky-900">
          Поиск принтеров в локальных подсетях и SNMP-опрос (обычно 40–120 с). Не закрывайте вкладку.
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {[
          ['Всего', stats.total, ''],
          ['Доступно', stats.online, 'text-emerald-700'],
          ['Offline', stats.offline, 'text-red-700'],
          ['SNMP OK', stats.snmpOk, 'text-red-700'],
          ['Мало тонера', stats.lowToner, 'text-amber-700'],
        ].map(([label, val, cls]) => (
          <div key={String(label)} className="rounded-2xl border border-slate-200/90 bg-white/90 px-3 py-2.5 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{label}</div>
            <div className={`text-xl font-bold text-slate-900 ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      <div className="mb-4 flex flex-col gap-3 rounded-2xl border border-slate-200/90 bg-white/90 p-4 shadow-sm sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="min-w-[min(100%,18rem)] flex-1">
          <label htmlFor="printer-search" className="app-label">
            Поиск
          </label>
          <input id="printer-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="IP, модель SNMP, имя…" className="app-input" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Фильтр</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(FILTER_LABELS) as FilterChip[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                  filter === key
                    ? 'bg-red-600 text-white ring-2 ring-red-300 ring-offset-1'
                    : 'rounded-full bg-zinc-50 px-2 py-0.5 text-neutral-900 ring-1 ring-zinc-200/80 opacity-90 hover:opacity-100'
                }`}
              >
                {FILTER_LABELS[key]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="app-card overflow-hidden p-0 shadow-[0_4px_24px_-8px_rgb(15_23_42_/_0.12)]">
        <div className="-mx-0 overflow-x-auto overscroll-x-contain">
          <table className="min-w-[720px] w-full text-left text-sm">
            <thead className="app-table-head">
              <tr>
                {canEdit ? (
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label="Выбрать все"
                    />
                  </th>
                ) : null}
                <th className="px-4 py-3">Модель</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Локация</th>
                <th className="px-4 py-3">Страницы</th>
                <th className="min-w-[12rem] px-4 py-3">Расходники</th>
                <th className="px-4 py-3">Последний опрос</th>
                {canEdit ? <th className="px-4 py-3 text-right">Действия</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr>
                  <td colSpan={canEdit ? 7 : 6} className="px-4 py-8 text-center text-slate-500">
                    Загрузка…
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={canEdit ? 7 : 6} className="px-4 py-12 text-center">
                    <p className="text-sm font-medium text-slate-700">{rows.length === 0 ? 'Нет принтеров' : 'Нет по фильтру'}</p>
                    <p className="mt-1 text-sm text-slate-500">
                      Нажмите «Найти и опросить»: сервер просканирует локальные подсети по SNMP UDP/161 и добавит
                      найденные принтеры.
                    </p>
                    {canEdit && rows.length === 0 ? (
                      <div className="mt-4 flex justify-center gap-2">
                        <button type="button" className="app-btn app-btn-primary" onClick={() => void pollAll()} disabled={pollBusy}>
                          {pollBusyLabel}
                        </button>
                        <button type="button" className="app-btn app-btn-secondary" onClick={() => setAddOpen(true)}>
                          + Добавить вручную
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ) : (
                filteredRows.map((r) => {
                  const low = hasLowToner(r.supplies)
                  const title = displayTitle(r)
                  return (
                    <tr key={r.id} className={`app-table-row ${low ? 'bg-amber-50/40' : ''}`}>
                      {canEdit ? (
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleOne(r.id)}
                            aria-label={`Выбрать ${title}`}
                          />
                        </td>
                      ) : null}
                      <td className="max-w-[14rem] px-4 py-3">
                        <div className="truncate font-medium text-slate-900" title={title}>
                          {title}
                        </div>
                        {r.snmp_model && r.name !== r.snmp_model ? (
                          <div className="truncate text-xs text-slate-400" title={r.name}>
                            {r.name}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600">{r.ip_address ?? '—'}</td>
                      <td className="max-w-[10rem] truncate px-4 py-3 text-slate-600">{r.location ?? '—'}</td>
                      <td className="px-4 py-3 font-mono tabular-nums font-semibold text-neutral-900">
                        {r.page_count != null ? r.page_count.toLocaleString('ru-RU') : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <SuppliesCell supplies={r.supplies ?? []} />
                      </td>
                      <td className="px-4 py-3 text-slate-500">{fmtWhen(r.last_poll_at ?? r.last_snmp_at)}</td>
                      {canEdit ? (
                        <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex flex-col items-end gap-0.5">
                            <button
                              type="button"
                              className="rounded-lg px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                              onClick={() => void pollOne(r)}
                            >
                              SNMP
                            </button>
                            <button
                              type="button"
                              className="rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                              onClick={() => setDeleteTarget({ ids: [r.id], labels: [title] })}
                            >
                              Удалить
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {cfgOpen && cfg && canEdit ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="app-card w-full max-w-2xl p-0 shadow-2xl ring-1 ring-white/40">
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div>
                <h2 className="text-lg font-bold text-slate-950">Настройки SNMP</h2>
                <p className="mt-1 text-sm text-slate-500">Опрос принтеров, расписание, community и таймауты.</p>
              </div>
              <button
                type="button"
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
                onClick={() => setCfgOpen(false)}
                aria-label="Закрыть настройки SNMP"
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-sm">
                <input type="checkbox" checked={cfg.poll_enabled} onChange={(e) => setCfg({ ...cfg, poll_enabled: e.target.checked })} />
                Автоопрос каждые {cfg.poll_interval_minutes} мин
              </label>
              <label className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-sm">
                <input type="checkbox" checked={cfg.snmp_enabled} onChange={(e) => setCfg({ ...cfg, snmp_enabled: e.target.checked })} />
                SNMP (тонер, страницы)
              </label>
              <label className="block text-sm">
                <span className="app-label">Интервал (мин)</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={cfg.poll_interval_minutes}
                  onChange={(e) => setCfg({ ...cfg, poll_interval_minutes: Number(e.target.value) || 30 })}
                  className="app-input"
                />
              </label>
              <label className="block text-sm">
                <span className="app-label">Community</span>
                <input value={cfg.snmp_community} onChange={(e) => setCfg({ ...cfg, snmp_community: e.target.value })} className="app-input font-mono" />
              </label>
              <label className="block text-sm">
                <span className="app-label">Timeout (сек)</span>
                <input
                  type="number"
                  min={1}
                  max={60}
                  step={0.5}
                  value={cfg.snmp_timeout_seconds}
                  onChange={(e) => setCfg({ ...cfg, snmp_timeout_seconds: Number(e.target.value) || 5 })}
                  className="app-input"
                />
              </label>
              <label className="block text-sm">
                <span className="app-label">Параллельность</span>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={cfg.poll_concurrency}
                  onChange={(e) => setCfg({ ...cfg, poll_concurrency: Number(e.target.value) || 6 })}
                  className="app-input"
                />
              </label>
            </div>

            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-4">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setCfgOpen(false)} disabled={cfgBusy}>
                Скрыть
              </button>
              <button type="button" disabled={cfgBusy} onClick={() => void saveConfig()} className="app-btn app-btn-primary">
                {cfgBusy ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="app-card w-full max-w-md p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between">
              <h2 className="text-lg font-bold">Добавить вручную</h2>
              <button type="button" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" onClick={() => setAddOpen(false)}>
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="app-label">Название (для себя)</span>
                <input value={addName} onChange={(e) => setAddName(e.target.value)} className="app-input" placeholder="HP 3 этаж" />
              </label>
              <label className="block">
                <span className="app-label">IP (обязательно)</span>
                <input value={addIp} onChange={(e) => setAddIp(e.target.value)} placeholder="192.168.1.50" className="app-input font-mono" required />
              </label>
              <label className="block">
                <span className="app-label">Локация</span>
                <input value={addLocation} onChange={(e) => setAddLocation(e.target.value)} className="app-input" />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setAddOpen(false)}>
                Отмена
              </button>
              <button type="button" disabled={addBusy || !addName.trim() || !addIp.trim()} className="app-btn app-btn-primary" onClick={() => void submitAdd()}>
                {addBusy ? 'Сохранение…' : 'Добавить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="app-card w-full max-w-md border-red-200 p-4 shadow-2xl ring-1 ring-red-100">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-red-800">Удаление принтеров</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {deleteTarget.ids.length === 1
                    ? 'Принтер будет удалён из базы. SNMP-данные тоже пропадут.'
                    : `Будет удалено принтеров: ${deleteTarget.ids.length}.`}
                </p>
              </div>
              <button type="button" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" onClick={() => setDeleteTarget(null)}>
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <ul className="mb-4 max-h-40 overflow-y-auto rounded-xl border border-red-100 bg-red-50/50 px-3 py-2 text-sm text-slate-800">
              {deleteTarget.labels.slice(0, 12).map((label) => (
                <li key={label} className="truncate py-0.5">
                  {label}
                </li>
              ))}
              {deleteTarget.labels.length > 12 ? (
                <li className="py-0.5 text-slate-500">…и ещё {deleteTarget.labels.length - 12}</li>
              ) : null}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
                Отмена
              </button>
              <button type="button" className="app-btn app-btn-danger" onClick={() => void confirmDelete()} disabled={deleteBusy}>
                {deleteBusy ? 'Удаление…' : 'Удалить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
