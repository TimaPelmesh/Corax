import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type NetworkPrinter,
  type PrinterPollConfig,
  type PrinterSchedulerStatus,
  type PrinterSupply,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconClose, IconPrinter } from '../components/icons'
import { PrinterDetailModal } from '../components/PrinterDetailModal'
import { useLocale } from '../i18n/LocaleContext'
import type { MessageKey } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type FilterChip = 'all' | 'offline' | 'low_toner' | 'snmp_error'

function fmtWhen(iso: string | null | undefined, locale: string) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
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
  return name || row.ip_address || 'Printer'
}

function formatSchedulerShort(
  sched: PrinterSchedulerStatus | null,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
  locale: string,
): string {
  if (!sched) return t('printers.autoPoll')
  if (!sched.poll_enabled) return t('printers.autoOff')
  if (sched.running_now) return t('printers.autoRunning')
  const mins = sched.poll_interval_minutes
  const last = sched.last_run_at ? fmtWhen(sched.last_run_at, locale) : null
  return last
    ? t('printers.autoLast', { mins, last })
    : t('printers.autoEvery', { mins })
}

function supplyBarColor(pct: number | null) {
  if (pct == null) return 'bg-slate-300'
  if (pct <= 10) return 'bg-blue-600'
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
      className={colored ? 'min-w-[5.5rem] max-w-[14rem]' : 'min-w-[5.5rem] max-w-[14rem]'}
      title={s.name}
    >
      <div
        className={`flex items-start gap-1 text-[10px] leading-snug ${low && colored ? 'font-semibold text-blue-700' : 'font-medium text-slate-600'}`}
      >
        <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ring-1 ring-black/10 ${tone.dot}`} />
        <span className={`min-w-0 break-words ${tone.text}`}>{s.name}</span>
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

function SuppliesCell({ supplies, serviceLabel }: { supplies: PrinterSupply[]; serviceLabel: string }) {
  if (!supplies.length) {
    return <span className="text-xs text-slate-400">—</span>
  }
  const { toners, service } = partitionSupplies(supplies)
  return (
    <div className="min-w-[10rem] space-y-1.5">
      {toners.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {toners.map((s) => (
            <SupplyChip key={s.name} s={s} colored />
          ))}
        </div>
      ) : null}
      {service.length > 0 ? (
        <div className="border-t border-dashed border-slate-200/90 pt-1.5">
          <div className="mb-1 text-[9px] font-semibold uppercase tracking-wide text-slate-400">{serviceLabel}</div>
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

const FILTER_KEYS: Record<FilterChip, MessageKey> = {
  all: 'printers.filterAll',
  offline: 'printers.filterOffline',
  low_toner: 'printers.filterLowToner',
  snmp_error: 'printers.filterSnmpErr',
}

type ColKey = 'model' | 'ip' | 'location' | 'status' | 'pages' | 'supplies' | 'lastPoll' | 'actions'

const COL_KEYS: Record<ColKey, MessageKey> = {
  model: 'printers.colModel',
  ip: 'printers.colIp',
  location: 'printers.colLocation',
  status: 'printers.colStatus',
  pages: 'printers.colPages',
  supplies: 'printers.colSupplies',
  lastPoll: 'printers.colLastPoll',
  actions: 'printers.colActions',
}

const DEFAULT_COLS: Record<ColKey, boolean> = {
  model: true,
  ip: true,
  location: true,
  status: true,
  pages: true,
  supplies: true,
  lastPoll: true,
  actions: true,
}

const COLS_STORAGE_KEY = 'corax-printers-cols-v1'

function loadVisibleCols(): Record<ColKey, boolean> {
  try {
    const raw = localStorage.getItem(COLS_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_COLS }
    const parsed = JSON.parse(raw) as Partial<Record<ColKey, boolean>>
    return { ...DEFAULT_COLS, ...parsed, model: true }
  } catch {
    return { ...DEFAULT_COLS }
  }
}

type DeleteTarget = {
  ids: number[]
  labels: string[]
}

export function PrintersPage() {
  const { user } = useAuth()
  const { t, locale } = useLocale()
  const toast = useToast()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')

  const [rows, setRows] = useState<NetworkPrinter[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterChip>('all')
  const [pollBusy, setPollBusy] = useState(false)
  const [cleanupBusy, setCleanupBusy] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)
  const [colsQuery, setColsQuery] = useState('')
  const [visibleCols, setVisibleCols] = useState<Record<ColKey, boolean>>(() => loadVisibleCols())
  const lastSchedRunRef = useRef<string | null>(null)
  const hourSyncedRef = useRef(false)
  const moreMenuRef = useRef<HTMLDivElement>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIp, setAddIp] = useState('')
  const [addLocation, setAddLocation] = useState('')
  const [addBusy, setAddBusy] = useState(false)

  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfg, setCfg] = useState<PrinterPollConfig | null>(null)
  const [sched, setSched] = useState<PrinterSchedulerStatus | null>(null)
  const [cfgBusy, setCfgBusy] = useState(false)
  const [detailPrinter, setDetailPrinter] = useState<NetworkPrinter | null>(null)

  const reload = useCallback(async (q: string) => {
    const data = await api.printers({ q: q.trim() || undefined, limit: 3000 })
    setRows(data)
    setSelected(new Set())
    return data
  }, [])

  const reloadMeta = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.printerPollConfig(), api.printerSchedulerStatus()])
      setCfg(c)
      setSched((prev) => {
        const prevRun = lastSchedRunRef.current
        const nextRun = s.last_run_at ?? null
        if (prev && prevRun && nextRun && nextRun !== prevRun && s.last_run_summary?.message) {
          toast.info(s.last_run_summary.message)
        }
        if (nextRun) lastSchedRunRef.current = nextRun
        else if (!lastSchedRunRef.current && s.last_run_at) {
          lastSchedRunRef.current = s.last_run_at
        }
        return s
      })
      // Разовый перевод на почасовой автоопрос (если ещё старые 30 мин)
      if (
        canEdit &&
        !hourSyncedRef.current &&
        c.poll_enabled &&
        c.poll_interval_minutes === 30
      ) {
        hourSyncedRef.current = true
        try {
          const saved = await api.updatePrinterPollConfig({
            poll_enabled: true,
            poll_interval_minutes: 60,
            snmp_enabled: c.snmp_enabled,
            snmp_community: c.snmp_community,
            snmp_timeout_seconds: c.snmp_timeout_seconds,
            ping_timeout_ms: c.ping_timeout_ms,
            poll_concurrency: c.poll_concurrency,
          })
          setCfg(saved)
          toast.ok(t('printers.hourBump'))
        } catch {
          /* ignore */
        }
      } else {
        hourSyncedRef.current = true
      }
    } catch {
      /* optional */
    }
  }, [canEdit, t, toast])

  useEffect(() => {
    localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(visibleCols))
  }, [visibleCols])

  useEffect(() => {
    if (!colsOpen) return
    const onDoc = (e: MouseEvent) => {
      if (!moreMenuRef.current?.contains(e.target as Node)) {
        setColsOpen(false)
        setColsQuery('')
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setColsOpen(false)
        setColsQuery('')
      }
    }
    document.addEventListener('mousedown', onDoc)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      window.removeEventListener('keydown', onKey)
    }
  }, [colsOpen])

  const filteredColKeys = useMemo(() => {
    const q = colsQuery.trim().toLowerCase()
    return (Object.keys(COL_KEYS) as ColKey[]).filter((key) => {
      if (key === 'actions' && !canEdit) return false
      if (!q) return true
      return t(COL_KEYS[key]).toLowerCase().includes(q)
    })
  }, [colsQuery, canEdit, t])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        await Promise.all([reload(search), reloadMeta()])
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('printers.loadFailed'))
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

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'offline') return r.poll_status === 'offline'
      if (filter === 'low_toner') return hasLowToner(r.supplies)
      if (filter === 'snmp_error') return r.snmp_status === 'error'
      return true
    })
  }, [rows, filter])

  const stats = useMemo(() => {
    const lowTonerRows = rows.filter((r) => hasLowToner(r.supplies))
    return {
      total: rows.length,
      online: rows.filter((r) => r.poll_status === 'online').length,
      snmpOk: rows.filter((r) => r.snmp_status === 'ok').length,
      snmpError: rows.filter((r) => r.snmp_status === 'error').length,
      lowToner: lowTonerRows.length,
      lowTonerRows,
    }
  }, [rows])

  const colCount = useMemo(() => {
    let n = 0
    if (canEdit) n += 1
    for (const k of Object.keys(visibleCols) as ColKey[]) {
      if (k === 'actions' && !canEdit) continue
      if (visibleCols[k]) n += 1
    }
    return Math.max(n, 1)
  }, [visibleCols, canEdit])

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
    toast.busy(t('printers.polling'))
    try {
      const r = await api.pollAllPrinters()
      const [data] = await Promise.all([reload(search), reloadMeta()])
      const low = data.filter((row) => hasLowToner(row.supplies)).length
      const snmpErr = data.filter((row) => row.snmp_status === 'error').length
      const alerts: string[] = []
      if (low > 0) alerts.push(t('printers.alertLow', { n: low }))
      if (snmpErr > 0) alerts.push(t('printers.alertSnmp', { n: snmpErr }))
      const base = r.message?.trim() || t('printers.pollDone')
      const message = alerts.length
        ? `${base}\n${t('printers.alertsAfterPoll', { alerts: alerts.join(' · ') })}`
        : base
      if (alerts.length) toast.warn(message)
      else toast.info(message)
    } catch (e) {
      toast.dismiss()
      toast.error(e instanceof Error ? e.message : t('printers.pollFailed'))
    } finally {
      setPollBusy(false)
    }
  }

  const pollBusyLabel = pollBusy || sched?.running_now ? t('printers.pollBusy') : t('printers.pollAll')

  const pollOne = async (row: NetworkPrinter) => {
    if (!canEdit || !row.ip_address) return
    try {
      await api.pollPrinter(row.id)
      await reload(search)
      toast.ok(t('printers.snmpUpdated', { name: displayTitle(row) }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printers.pollFailed'))
    }
  }

  const runCleanup = async () => {
    if (!canEdit) return
    setCleanupBusy(true)
    try {
      const r = await api.cleanupPrinters()
      await reload(search)
      toast.info(
        t('printers.cleanupResult', {
          dup: r.deleted_duplicates,
          noise: r.deleted_noise,
          noIp: r.deleted_no_ip,
          remaining: r.remaining,
        }),
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printers.cleanupFailed'))
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
      toast.ok(t('printers.deletedN', { n: deleteTarget.ids.length }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printers.deleteFailed'))
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
      toast.ok(t('printers.settingsSaved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printers.saveFailed'))
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
      toast.info(t('printers.addedHint'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('printers.addFailed'))
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
            <h1 className="page-title">{t('titles.printers')}</h1>
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">{t('pages.printersSubtitle')}</p>
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">
          <div
            className="inline-flex max-w-[min(100%,18rem)] items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-[11px] font-medium text-[var(--color-fg-muted)]"
            title={sched?.last_run_summary?.message || undefined}
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                sched?.running_now || pollBusy
                  ? 'bg-[var(--color-primary)]'
                  : sched?.poll_enabled
                    ? 'bg-[var(--color-fg-subtle)]'
                    : 'bg-amber-500'
              }`}
              aria-hidden
            />
            <span className="truncate">{formatSchedulerShort(sched, t, locale)}</span>
          </div>
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={() => void pollAll()}
                disabled={pollBusy || sched?.running_now}
                className="app-btn app-btn-primary"
              >
                {pollBusyLabel}
              </button>
              <button type="button" onClick={() => setAddOpen(true)} className="app-btn app-btn-secondary">
                {t('printers.addManual')}
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
                  {t('printers.deleteN', { n: selected.size })}
                </button>
              ) : null}
            </>
          ) : null}
          <div className="relative" ref={moreMenuRef}>
            <button
              type="button"
              onClick={() => setColsOpen((v) => !v)}
              className="app-btn app-btn-secondary"
              aria-expanded={colsOpen}
            >
              {t('printers.moreActions')}
            </button>
            {colsOpen ? (
              <div className="absolute right-0 z-40 mt-1.5 w-[min(18rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-xl">
                {canEdit ? (
                  <div className="mb-2 space-y-0.5 border-b border-[var(--color-border)] pb-2">
                    <button
                      type="button"
                      className="w-full rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
                      onClick={() => {
                        setColsOpen(false)
                        setCfgOpen(true)
                      }}
                    >
                      {t('printers.snmpSettings')}
                    </button>
                    <button
                      type="button"
                      className="w-full rounded-lg px-2.5 py-2 text-left text-sm font-medium text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-60"
                      disabled={cleanupBusy}
                      onClick={() => {
                        setColsOpen(false)
                        void runCleanup()
                      }}
                    >
                      {cleanupBusy ? t('printers.cleanupBusy') : t('printers.cleanup')}
                    </button>
                  </div>
                ) : null}
                <div className="mb-1.5 px-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                  {t('printers.columns')}
                </div>
                <input
                  type="search"
                  value={colsQuery}
                  onChange={(e) => setColsQuery(e.target.value)}
                  placeholder={t('printers.colSearch')}
                  className="app-input !min-h-0 mb-2 !rounded-lg !px-2.5 !py-1.5 !text-xs"
                  autoFocus
                />
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {filteredColKeys.length === 0 ? (
                    <p className="px-2 py-2 text-xs text-[var(--color-fg-subtle)]">{t('common.nothingFound')}</p>
                  ) : (
                    filteredColKeys.map((key) => {
                      const locked = key === 'model'
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                        >
                          <input
                            type="checkbox"
                            checked={visibleCols[key]}
                            disabled={locked}
                            onChange={() =>
                              setVisibleCols((prev) => ({
                                ...prev,
                                [key]: locked ? true : !prev[key],
                              }))
                            }
                          />
                          <span className={locked ? 'text-[var(--color-fg-subtle)]' : ''}>{t(COL_KEYS[key])}</span>
                        </label>
                      )
                    })
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          [t('common.total'), stats.total, ''],
          [t('printers.available'), stats.online, ''],
          [t('printers.snmpOk'), stats.snmpOk, ''],
          [t('printers.lowToner'), stats.lowToner, stats.lowToner ? 'text-amber-500' : ''],
        ].map(([label, val, cls]) => (
          <div key={String(label)} className="app-card px-3 py-2.5">
            <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{label}</div>
            <div className={`text-xl font-bold tabular-nums text-[var(--color-fg)] ${cls}`}>{val}</div>
          </div>
        ))}
      </div>

      <div className="app-card mb-4 flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-end sm:gap-4">
        <div className="min-w-[min(100%,18rem)] flex-1">
          <label htmlFor="printer-search" className="app-label">
            {t('common.search')}
          </label>
          <input id="printer-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="IP, SNMP…" className="app-input" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">{t('common.filter')}</div>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(FILTER_KEYS) as FilterChip[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`app-chip ${filter === key ? 'app-chip--active' : ''}`}
              >
                {t(FILTER_KEYS[key])}
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
                      aria-label={t('printers.selectAll')}
                    />
                  </th>
                ) : null}
                {visibleCols.model ? <th className="min-w-[16rem] px-4 py-3">{t('printers.colModel')}</th> : null}
                {visibleCols.ip ? <th className="px-4 py-3">{t('printers.colIp')}</th> : null}
                {visibleCols.location ? <th className="min-w-[8rem] px-4 py-3">{t('printers.colLocation')}</th> : null}
                {visibleCols.status ? <th className="px-4 py-3">{t('printers.colStatus')}</th> : null}
                {visibleCols.pages ? <th className="px-4 py-3">{t('printers.colPages')}</th> : null}
                {visibleCols.supplies ? <th className="min-w-[14rem] px-4 py-3">{t('printers.colSupplies')}</th> : null}
                {visibleCols.lastPoll ? <th className="px-4 py-3">{t('printers.colLastPoll')}</th> : null}
                {canEdit && visibleCols.actions ? <th className="px-4 py-3 text-right">{t('printers.colActions')}</th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {loading ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-8 text-center text-slate-500">
                    {t('common.loading')}
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={colCount} className="px-4 py-12 text-center">
                    <p className="text-sm font-medium text-slate-700">{t('common.nothingFound')}</p>
                    {canEdit && rows.length === 0 ? (
                      <div className="mt-4 flex justify-center gap-2">
                        <button type="button" className="app-btn app-btn-primary" onClick={() => void pollAll()} disabled={pollBusy}>
                          {pollBusyLabel}
                        </button>
                        <button type="button" className="app-btn app-btn-secondary" onClick={() => setAddOpen(true)}>
                          {t('printers.addManual')}
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              ) : (
                filteredRows.map((r) => {
                  const low = hasLowToner(r.supplies)
                  const title = displayTitle(r)
                  const problem = r.snmp_status === 'error' || r.poll_status === 'offline' || low
                  const snmpBadge =
                    r.snmp_status === 'ok'
                      ? { text: 'SNMP OK', cls: 'bg-slate-100 text-slate-700 ring-slate-200' }
                      : r.snmp_status === 'error'
                        ? { text: 'SNMP err', cls: 'bg-rose-50 text-rose-800 ring-rose-200' }
                        : r.snmp_status === 'skipped'
                          ? { text: 'SNMP —', cls: 'bg-slate-50 text-slate-500 ring-slate-200' }
                          : { text: 'SNMP ?', cls: 'bg-slate-50 text-slate-500 ring-slate-200' }
                  const pollBadge =
                    r.poll_status === 'online'
                      ? { text: t('printers.statusOnline'), cls: 'bg-slate-100 text-slate-700 ring-slate-200' }
                      : r.poll_status === 'offline'
                        ? { text: t('printers.statusOffline'), cls: 'bg-amber-50 text-amber-900 ring-amber-200' }
                        : { text: t('printers.statusUnknown'), cls: 'bg-slate-50 text-slate-500 ring-slate-200' }
                  return (
                    <tr
                      key={r.id}
                      className={`app-table-row cursor-pointer ${problem ? 'bg-amber-50/35' : ''}`}
                      onClick={() => setDetailPrinter(r)}
                    >
                      {canEdit ? (
                        <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => toggleOne(r.id)}
                            aria-label={t('printers.selectOne', { name: title })}
                          />
                        </td>
                      ) : null}
                      {visibleCols.model ? (
                        <td className="min-w-[16rem] max-w-[22rem] px-4 py-3 align-top">
                          <div className="whitespace-normal break-words font-medium leading-snug text-slate-900" title={title}>
                            {title}
                          </div>
                          {r.snmp_model && r.name?.trim() && r.name.trim() !== r.snmp_model.trim() ? (
                            <div className="mt-0.5 whitespace-normal break-words text-xs leading-snug text-slate-500" title={r.name}>
                              {r.name}
                            </div>
                          ) : null}
                        </td>
                      ) : null}
                      {visibleCols.ip ? (
                        <td className="px-4 py-3 align-top font-mono text-slate-600">{r.ip_address ?? '—'}</td>
                      ) : null}
                      {visibleCols.location ? (
                        <td className="min-w-[8rem] max-w-[12rem] px-4 py-3 align-top">
                          <span className="whitespace-normal break-words text-slate-600">{r.location ?? '—'}</span>
                        </td>
                      ) : null}
                      {visibleCols.status ? (
                        <td className="px-4 py-3 align-top">
                          <div className="flex flex-col gap-1">
                            <span className={`inline-flex w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${pollBadge.cls}`}>
                              {pollBadge.text}
                            </span>
                            <span
                              className={`inline-flex w-fit rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ${snmpBadge.cls}`}
                              title={r.snmp_error || undefined}
                            >
                              {snmpBadge.text}
                            </span>
                            {r.snmp_error ? (
                              <span className="max-w-[11rem] whitespace-normal break-words text-[10px] leading-snug text-rose-700/90" title={r.snmp_error}>
                                {r.snmp_error}
                              </span>
                            ) : null}
                            {low ? (
                              <span className="inline-flex w-fit rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-amber-200">
                                {t('printers.lowTonerBadge')}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      ) : null}
                      {visibleCols.pages ? (
                        <td className="px-4 py-3 align-top font-mono tabular-nums font-semibold text-neutral-900">
                          {r.page_count != null ? r.page_count.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU') : '—'}
                        </td>
                      ) : null}
                      {visibleCols.supplies ? (
                        <td className="px-4 py-3 align-top">
                          <SuppliesCell supplies={r.supplies ?? []} serviceLabel={t('printers.service')} />
                        </td>
                      ) : null}
                      {visibleCols.lastPoll ? (
                        <td className="px-4 py-3 align-top text-slate-500">{fmtWhen(r.last_poll_at ?? r.last_snmp_at, locale)}</td>
                      ) : null}
                      {canEdit && visibleCols.actions ? (
                        <td className="px-4 py-3 text-right align-top" onClick={(e) => e.stopPropagation()}>
                          <div className="inline-flex flex-col items-end gap-0.5">
                            <button
                              type="button"
                              className="rounded-lg px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-50"
                              onClick={() => void pollOne(r)}
                            >
                              SNMP
                            </button>
                            <button
                              type="button"
                              className="rounded-lg px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100"
                              onClick={() => setDeleteTarget({ ids: [r.id], labels: [title] })}
                            >
                              {t('common.delete')}
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
                <h2 className="text-lg font-bold text-slate-950">{t('printers.snmpCfgTitle')}</h2>
                <p className="mt-1 text-sm text-slate-500">{t('printers.snmpCfgSub')}</p>
              </div>
              <button
                type="button"
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
                onClick={() => setCfgOpen(false)}
                aria-label={t('common.close')}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2">
              <label className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-sm">
                <input type="checkbox" checked={cfg.poll_enabled} onChange={(e) => setCfg({ ...cfg, poll_enabled: e.target.checked })} />
                {t('printers.pollEnabled')}
              </label>
              <label className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/70 px-3 py-2 text-sm">
                <input type="checkbox" checked={cfg.snmp_enabled} onChange={(e) => setCfg({ ...cfg, snmp_enabled: e.target.checked })} />
                {t('printers.snmpEnabled')}
              </label>
              <label className="block text-sm">
                <span className="app-label">{t('printers.intervalMin')}</span>
                <input
                  type="number"
                  min={1}
                  max={1440}
                  value={cfg.poll_interval_minutes}
                  onChange={(e) => setCfg({ ...cfg, poll_interval_minutes: Number(e.target.value) || 60 })}
                  className="app-input"
                />
              </label>
              <label className="block text-sm">
                <span className="app-label">{t('printers.community')}</span>
                <input value={cfg.snmp_community} onChange={(e) => setCfg({ ...cfg, snmp_community: e.target.value })} className="app-input font-mono" />
              </label>
              <label className="block text-sm">
                <span className="app-label">{t('printers.timeoutSec')}</span>
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
                <span className="app-label">{t('printers.concurrency')}</span>
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
                {t('common.cancel')}
              </button>
              <button type="button" disabled={cfgBusy} onClick={() => void saveConfig()} className="app-btn app-btn-primary">
                {cfgBusy ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {addOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="app-card w-full max-w-md p-4 shadow-2xl">
            <div className="mb-3 flex items-start justify-between">
              <h2 className="text-lg font-bold">{t('printers.addTitle')}</h2>
              <button type="button" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" onClick={() => setAddOpen(false)}>
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block">
                <span className="app-label">{t('printers.addName')}</span>
                <input value={addName} onChange={(e) => setAddName(e.target.value)} className="app-input" placeholder="HP" />
              </label>
              <label className="block">
                <span className="app-label">{t('printers.addIp')}</span>
                <input value={addIp} onChange={(e) => setAddIp(e.target.value)} placeholder="192.168.1.50" className="app-input font-mono" required />
              </label>
              <label className="block">
                <span className="app-label">{t('printers.addLocation')}</span>
                <input value={addLocation} onChange={(e) => setAddLocation(e.target.value)} className="app-input" />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setAddOpen(false)}>
                {t('common.cancel')}
              </button>
              <button type="button" disabled={addBusy || !addName.trim() || !addIp.trim()} className="app-btn app-btn-primary" onClick={() => void submitAdd()}>
                {addBusy ? t('common.loading') : t('common.add')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center">
          <div className="app-card w-full max-w-md border-blue-200 p-4 shadow-2xl ring-1 ring-blue-100">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-blue-800">{t('printers.deleteTitle')}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {deleteTarget.ids.length === 1
                    ? t('printers.deleteOne')
                    : t('printers.deleteMany', { n: deleteTarget.ids.length })}
                </p>
              </div>
              <button type="button" className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" onClick={() => setDeleteTarget(null)}>
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <ul className="mb-4 max-h-40 overflow-y-auto rounded-xl border border-red-100 bg-blue-50/50 px-3 py-2 text-sm text-slate-800">
              {deleteTarget.labels.slice(0, 12).map((label) => (
                <li key={label} className="truncate py-0.5">
                  {label}
                </li>
              ))}
              {deleteTarget.labels.length > 12 ? (
                <li className="py-0.5 text-slate-500">{t('printers.andMore', { n: deleteTarget.labels.length - 12 })}</li>
              ) : null}
            </ul>
            <div className="flex justify-end gap-2">
              <button type="button" className="app-btn app-btn-secondary" onClick={() => setDeleteTarget(null)} disabled={deleteBusy}>
                {t('common.cancel')}
              </button>
              <button type="button" className="app-btn app-btn-danger" onClick={() => void confirmDelete()} disabled={deleteBusy}>
                {deleteBusy ? t('common.loading') : t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <PrinterDetailModal
        printer={detailPrinter}
        onClose={() => setDetailPrinter(null)}
        onChanged={(updated) => {
          setDetailPrinter(updated)
          setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
        }}
      />
    </div>
  )
}
