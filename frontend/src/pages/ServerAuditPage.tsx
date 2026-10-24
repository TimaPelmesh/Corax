import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type Computer, type ServerAuditDetail, type ServerAuditHost } from '../api'
import { useAuth } from '../AuthContext'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { ServerAuditCharts } from './ServerAuditCharts'

const INTERVALS = [0, 15, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400] as const

type Hours = 6 | 24 | 168
type Status = 'all' | 'fresh' | 'stale' | 'none' | 'off'
type SortKey = 'name' | 'temp' | 'cpu' | 'seen'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((item) => item && typeof item === 'object') as Record<string, unknown>[]
}

function textOf(value: unknown): string {
  if (value == null || value === '') return '—'
  return String(value)
}

function numOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

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

function fmtRate(bps: number | null | undefined) {
  if (bps == null || Number.isNaN(bps)) return '—'
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

function fmtUptime(sec: number | null | undefined) {
  if (sec == null) return '—'
  const days = Math.floor(sec / 86400)
  const hours = Math.floor((sec % 86400) / 3600)
  const mins = Math.floor((sec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function fmtPct(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—'
  return `${Math.round(value)}%`
}

function fmtTemp(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return '—'
  return `${value.toFixed(1)}°C`
}

function sensorKind(row: Record<string, unknown>): 'gpu' | 'cpu' | 'other' {
  const given = String(row.kind || '')
  if (given === 'gpu' || given === 'cpu' || given === 'other') return given
  const blob = `${row.source || ''} ${row.name || ''}`.toLowerCase()
  if (/nvidia|amdgpu|radeon|nouveau|\bgpu\b|vga/.test(blob)) return 'gpu'
  if (/pkg|tctl|tdie|tccd|k10|cpu|core|x86|package/.test(blob)) return 'cpu'
  return 'other'
}

function heatClass(celsius: number | null) {
  if (celsius == null) return 'text-[var(--color-fg-subtle)]'
  if (celsius >= 80) return 'text-rose-600 dark:text-rose-400'
  if (celsius >= 68) return 'text-amber-600 dark:text-amber-400'
  return 'text-emerald-600 dark:text-emerald-400'
}

function heatBar(celsius: number | null) {
  if (celsius == null) return 'bg-[var(--color-border)]'
  if (celsius >= 80) return 'bg-rose-500'
  if (celsius >= 68) return 'bg-amber-500'
  return 'bg-emerald-500'
}

function isLinuxOs(os: string | null | undefined) {
  return /linux|debian|ubuntu|centos|rhel|red hat|alma|rocky|suse|oracle|fedora|astra|redos|alt linux|альт|астра|ред\s*ос/i.test(os || '')
}

function isLogError(level: string) {
  return level === 'emerg' || level === 'alert' || level === 'crit' || level === 'err'
}

function intervalSecOf(host: { interval_seconds?: number | null; interval_minutes: number }) {
  if (typeof host.interval_seconds === 'number' && Number.isFinite(host.interval_seconds)) return host.interval_seconds
  return Math.max(0, (host.interval_minutes || 0) * 60)
}

function freshness(host: ServerAuditHost): 'fresh' | 'stale' | 'none' {
  if (!host.last_sample_at) return 'none'
  const age = Date.now() - new Date(host.last_sample_at).getTime()
  const seconds = intervalSecOf(host)
  const windowMs = seconds > 0 ? Math.max(seconds * 2, 45) * 1000 : 20 * 60_000
  if (!Number.isFinite(age) || age < 0) return 'fresh'
  return age <= windowMs ? 'fresh' : 'stale'
}

function pctClass(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return 'text-[var(--color-fg-subtle)]'
  if (value >= 90) return 'text-rose-600 dark:text-rose-400'
  if (value >= 75) return 'text-amber-600 dark:text-amber-400'
  return 'text-[var(--color-fg)]'
}

function pctBar(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return 'bg-[var(--color-border)]'
  if (value >= 90) return 'bg-rose-500'
  if (value >= 75) return 'bg-amber-500'
  return 'bg-sky-500'
}

function loadRatio(load: number | null | undefined, cores: number) {
  if (load == null || Number.isNaN(load)) return 0
  return Math.max(0, load / Math.max(cores, 1))
}

function loadClass(load: number | null | undefined, cores: number) {
  const ratio = loadRatio(load, cores)
  if (load == null) return 'text-[var(--color-fg-subtle)]'
  if (ratio >= 1) return 'text-rose-600 dark:text-rose-400'
  if (ratio >= 0.7) return 'text-amber-600 dark:text-amber-400'
  return 'text-[var(--color-fg)]'
}

function loadBar(load: number | null | undefined, cores: number) {
  const ratio = loadRatio(load, cores)
  if (load == null) return 'bg-[var(--color-border)]'
  if (ratio >= 1) return 'bg-rose-500'
  if (ratio >= 0.7) return 'bg-amber-500'
  return 'bg-slate-500'
}

function tempRatio(celsius: number | null | undefined) {
  if (celsius == null || Number.isNaN(celsius)) return 0
  return Math.max(0, Math.min(1, (celsius - 20) / 80))
}

export function ServerAuditPage() {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const { user } = useAuth()
  const confirm = useConfirmDialog()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')
  const [searchParams, setSearchParams] = useSearchParams()

  const [hosts, setHosts] = useState<ServerAuditHost[]>([])
  const [detail, setDetail] = useState<ServerAuditDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [hostname, setHostname] = useState('')
  const [label, setLabel] = useState('')
  const [intervalSec, setIntervalSec] = useState(900)
  const [busy, setBusy] = useState(false)
  const [fleetQuery, setFleetQuery] = useState('')
  const [fleetOpen, setFleetOpen] = useState(false)
  const [fleetItems, setFleetItems] = useState<Computer[]>([])
  const [linuxOnly, setLinuxOnly] = useState(true)
  const [logMode, setLogMode] = useState<'err' | 'all'>('err')
  const [hostQuery, setHostQuery] = useState('')
  const [sensorQuery, setSensorQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [panel, setPanel] = useState<'charts' | 'sensors' | 'lists' | 'journal' | 'control'>('charts')
  const [draftLabel, setDraftLabel] = useState('')
  const [draftNotes, setDraftNotes] = useState('')
  const [paused, setPaused] = useState(false)
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const [polledAt, setPolledAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  const rangeRaw = Number(searchParams.get('range'))
  const hours: Hours = rangeRaw === 6 || rangeRaw === 168 ? rangeRaw : 24
  const statusRaw = searchParams.get('status')
  const status: Status = statusRaw === 'fresh' || statusRaw === 'stale' || statusRaw === 'none' || statusRaw === 'off' ? statusRaw : 'all'
  const sortRaw = searchParams.get('sort')
  const sortKey: SortKey = sortRaw === 'name' || sortRaw === 'cpu' || sortRaw === 'seen' ? sortRaw : 'temp'
  const sortDir: 'asc' | 'desc' = searchParams.get('dir') === 'asc' ? 'asc' : 'desc'
  const hostParam = Number(searchParams.get('host'))
  const selectedId = hosts.some((host) => host.id === hostParam) ? hostParam : (hosts[0]?.id ?? null)

  const setParams = useCallback((patch: Record<string, string | null>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [key, value] of Object.entries(patch)) {
        if (value == null || value === '') next.delete(key)
        else next.set(key, value)
      }
      return next
    }, { replace: true })
  }, [setSearchParams])

  const loadHosts = useCallback(async () => {
    const rows = await api.serverAuditHosts()
    setHosts(rows)
    return rows
  }, [])

  const loadDetail = useCallback(async (id: number, range: Hours) => {
    const row = await api.serverAuditHost(id, range)
    setDetail(row)
    setHosts((current) => current.map((host) => (host.id === row.id ? { ...host, ...row } : host)))
  }, [])

  useEffect(() => {
    if (!canEdit || !fleetOpen) return
    const query = fleetQuery.trim()
    let alive = true
    const timer = window.setTimeout(() => {
      api
        .computers({
          q: query || undefined,
          limit: query ? 30 : 40,
          sort: 'host',
          sort_dir: 'asc',
          platform: linuxOnly ? 'linux' : undefined,
        })
        .then((res) => {
          if (alive) setFleetItems(res.items)
        })
        .catch(() => {
          if (alive) setFleetItems([])
        })
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [canEdit, fleetOpen, fleetQuery, linuxOnly])

  useEffect(() => {
    setLogMode('err')
    setDraftLabel('')
    setDraftNotes('')
  }, [selectedId])

  useEffect(() => {
    if (!detail || detail.id !== selectedId) return
    setDraftLabel(detail.label || '')
    setDraftNotes(detail.notes || '')
  }, [detail?.id, selectedId])

  useEffect(() => {
    if (hosts.length === 0) return
    if (hosts.some((host) => host.id === hostParam)) return
    setParams({ host: String(hosts[0].id) })
  }, [hostParam, hosts, setParams])

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    loadHosts()
      .catch((error: unknown) => {
        if (alive) toast.error(error instanceof Error ? error.message : t('common.error'))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [loadHosts, t, toast])

  const hurry = hosts.some((host) => host.collect_requested || !host.last_sample_at)
  const fastest = hosts.reduce((min, host) => {
    if (!host.enabled) return min
    const seconds = intervalSecOf(host)
    if (seconds <= 0) return min
    return Math.min(min, seconds)
  }, 3600)
  const pollMs = hours >= 168 ? 30_000 : fastest <= 60 ? 5_000 : hurry ? 8_000 : 20_000
  const remainSec = paused ? null : Math.max(0, Math.ceil((pollMs - (now - polledAt)) / 1000))

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      return
    }
    let alive = true
    const run = () => {
      setPolledAt(Date.now())
      loadDetail(selectedId, hours).catch((error: unknown) => {
        if (alive) toast.error(error instanceof Error ? error.message : t('common.error'))
      })
      void loadHosts().catch(() => undefined)
    }
    run()
    if (paused) return () => { alive = false }
    const timer = window.setInterval(run, pollMs)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [hours, loadDetail, loadHosts, paused, pollMs, selectedId, t, toast])

  const payload = detail?.payload ?? {}
  const os = asRecord(payload.os)
  const cpu = asRecord(payload.cpu)
  const packages = asRecord(payload.packages)
  const pressure = asRecord(payload.pressure)
  const sockets = asRecord(payload.sockets)
  const timeInfo = asRecord(payload.time)
  const temps = asRows(payload.temperatures)
  const voltages = asRows(payload.voltages)
  const fans = asRows(payload.fans)
  const disks = asRows(payload.disks)
  const diskIo = asRows(payload.disk_io)
  const memory = asRecord(payload.memory)
  const loadInfo = asRecord(payload.load)
  const cluster = asRecord(payload.cluster)
  const files = asRecord(payload.files)
  const perCore = Array.isArray(cpu?.per_core)
    ? cpu.per_core.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    : []
  const processes = asRows(payload.processes)
  const listeners = asRows(payload.listeners)
  const failed = asRows(payload.failed_units)
  const logs = asRows(payload.logs)
  const logSource = typeof payload.logs_source === 'string' ? payload.logs_source : ''
  const sessions = asRows(payload.sessions)
  const docker = asRows(payload.docker)
  const network = asRows(payload.network)

  const suggestions = useMemo(() => {
    const enrolled = new Set(hosts.map((host) => host.hostname.toLowerCase()))
    return fleetItems
      .filter((computer) => !linuxOnly || isLinuxOs(computer.os_name))
      .slice(0, 12)
      .map((computer) => ({ computer, enrolled: enrolled.has(computer.hostname.toLowerCase()) }))
  }, [fleetItems, hosts, linuxOnly])

  const stats = useMemo(
    () => ({
      total: hosts.length,
      live: hosts.filter((host) => host.enabled && freshness(host) === 'fresh').length,
      wait: hosts.filter((host) => host.enabled && freshness(host) === 'none').length,
      stale: hosts.filter((host) => host.enabled && freshness(host) === 'stale').length,
    }),
    [hosts],
  )

  const visibleHosts = useMemo(() => {
    const query = hostQuery.trim().toLowerCase()
    const rows = hosts.filter((host) => {
      if (status === 'off') {
        if (host.enabled) return false
      } else if (status !== 'all' && (freshness(host) !== status || !host.enabled)) {
        return false
      }
      if (!query) return true
      return [host.hostname, host.label, host.ip_address, host.os_summary].some((part) =>
        (part || '').toLowerCase().includes(query),
      )
    })
    rows.sort((a, b) => {
      const dir = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'temp') return ((a.latest_cpu_temp_c ?? -1) - (b.latest_cpu_temp_c ?? -1)) * dir
      if (sortKey === 'cpu') return ((a.latest_cpu_percent ?? -1) - (b.latest_cpu_percent ?? -1)) * dir
      if (sortKey === 'seen') return (a.last_sample_at || '').localeCompare(b.last_sample_at || '') * dir
      return (a.label || a.hostname).localeCompare(b.label || b.hostname, locale === 'en' ? 'en' : 'ru') * dir
    })
    return rows
  }, [hostQuery, hosts, locale, sortDir, sortKey, status])

  const sensorNeedle = sensorQuery.trim().toLowerCase()
  const shownTemps = sensorNeedle
    ? temps.filter((row) => `${textOf(row.name)} ${textOf(row.source)}`.toLowerCase().includes(sensorNeedle))
    : temps
  const shownVolts = sensorNeedle
    ? voltages.filter((row) => `${textOf(row.name)} ${textOf(row.source)}`.toLowerCase().includes(sensorNeedle))
    : voltages
  const gpus = asRows(payload.gpus)
  const gpuFromSensors = temps
    .filter((row) => sensorKind(row) === 'gpu')
    .map((row) => numOf(row.celsius))
    .filter((value): value is number => value != null)
  const gpuNow = detail?.latest_gpu_temp_c ?? (gpuFromSensors.length ? Math.max(...gpuFromSensors) : null)
  const gpuHint = gpus[0] ? textOf(gpus[0].name) : gpuNow == null ? t('serverAudit.gpuIdle') : undefined
  const rankedTemps = [...shownTemps].sort((a, b) => {
    const rank = { gpu: 0, cpu: 1, other: 2 }
    const byKind = rank[sensorKind(a)] - rank[sensorKind(b)]
    if (byKind !== 0) return byKind
    return (numOf(b.celsius) ?? -1) - (numOf(a.celsius) ?? -1)
  })
  const tempSeries = [
    { label: t('serverAudit.temp'), color: '#e11d48', data: (detail?.points ?? []).map((point) => point.cpu_temp_c) },
    { label: t('serverAudit.gpu'), color: '#7c3aed', data: (detail?.points ?? []).map((point) => point.gpu_temp_c) },
  ].filter((series) => series.data.some((value) => value != null))

  const times = useMemo(() => (detail?.points ?? []).map((point) => point.collected_at), [detail?.points])

  function chooseComputer(computer: Computer) {
    const existing = hosts.find((host) => host.hostname.toLowerCase() === computer.hostname.toLowerCase())
    if (existing) {
      setParams({ host: String(existing.id) })
      setFleetOpen(false)
      return
    }
    setHostname(computer.hostname)
    setLabel(computer.os_name || computer.model || '')
    setFleetQuery(computer.hostname)
    setFleetOpen(false)
  }

  async function onAdd(event: React.FormEvent) {
    event.preventDefault()
    if (!canEdit) return
    setBusy(true)
    try {
      const created = await api.createServerAuditHost({
        hostname: hostname.trim(),
        label: label.trim() || null,
        interval_seconds: intervalSec,
      })
      setHostname('')
      setLabel('')
      setFleetQuery('')
      toast.ok(t('serverAudit.added'))
      await loadHosts()
      setParams({ host: String(created.id) })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function onCollect() {
    if (!detail || !canEdit) return
    setBusy(true)
    try {
      const updated = await api.collectServerAuditHost(detail.id)
      setDetail((current) => (current ? { ...current, ...updated } : current))
      setHosts((current) => current.map((host) => (host.id === updated.id ? { ...host, ...updated } : host)))
      toast.ok(t('serverAudit.queued'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function onInterval(next: number) {
    if (!detail || !canEdit) return
    try {
      const updated = await api.updateServerAuditHost(detail.id, { interval_seconds: next })
      setDetail((current) => (current ? { ...current, ...updated } : current))
      setHosts((current) => current.map((host) => (host.id === updated.id ? { ...host, ...updated } : host)))
      toast.ok(t('serverAudit.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  async function onJournal(patch: {
    journal_mode?: 'off' | 'errors' | 'all'
    journal_lines?: number
    retain_days?: number
  }) {
    if (!detail || !canEdit) return
    try {
      const updated = await api.updateServerAuditHost(detail.id, patch)
      setDetail((current) => (current ? { ...current, ...updated } : current))
      setHosts((current) => current.map((host) => (host.id === updated.id ? { ...host, ...updated } : host)))
      await loadDetail(detail.id, hours)
      toast.ok(t('serverAudit.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  async function onLabel(event: React.FormEvent) {
    event.preventDefault()
    if (!detail || !canEdit) return
    try {
      const updated = await api.updateServerAuditHost(detail.id, {
        label: draftLabel.trim() || null,
        notes: draftNotes.trim() || null,
      })
      setDetail((current) => (current ? { ...current, ...updated } : current))
      setHosts((current) => current.map((host) => (host.id === updated.id ? { ...host, ...updated } : host)))
      toast.ok(t('serverAudit.saved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  async function onToggle() {
    if (!detail || !canEdit) return
    try {
      const updated = await api.updateServerAuditHost(detail.id, { enabled: !detail.enabled })
      setDetail((current) => (current ? { ...current, ...updated } : current))
      setHosts((current) => current.map((host) => (host.id === updated.id ? { ...host, ...updated } : host)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  async function onDelete(host: ServerAuditHost) {
    if (!canEdit) return
    const ok = await confirm.ask({
      title: t('serverAudit.removeTitle'),
      body: t('serverAudit.removeBody', { host: host.label || host.hostname }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteServerAuditHost(host.id)
      const rows = await loadHosts()
      if (selectedId === host.id) setParams({ host: rows[0] ? String(rows[0].id) : null })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  function labelFor(seconds: number) {
    if (seconds <= 0) return t('serverAudit.manual')
    if (seconds < 60) return t('serverAudit.everySec', { n: seconds })
    return t('serverAudit.every', { n: Math.round(seconds / 60) })
  }

  const cores = Math.max(1, numOf(cpu?.cores) ?? 1)
  const worstDisk = disks.reduce<{ mount: string; pct: number } | null>((best, row) => {
    const pct = numOf(row.used_percent)
    if (pct == null) return best
    if (!best || pct > best.pct) return { mount: textOf(row.mount), pct }
    return best
  }, null)
  const diskPct = worstDisk?.pct ?? detail?.latest_disk_percent ?? null
  const diskHint = worstDisk ? worstDisk.mount : undefined

  async function reloadNow() {
    try {
      await loadHosts()
      if (selectedId != null) await loadDetail(selectedId, hours)
      setPolledAt(Date.now())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    }
  }

  const toneClass = {
    fresh: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
    stale: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    none: 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)]',
  }

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
      {confirm.dialog}
      <div className="chrome-glass-card flex flex-wrap items-center justify-between gap-3 p-3">
        <div className="flex flex-wrap gap-1">
          {([6, 24, 168] as Hours[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setParams({ range: value === 24 ? null : String(value) })}
              className={`app-chip ${hours === value ? 'app-chip--active' : ''}`}
            >
              {value === 6 ? t('serverAudit.range6') : value === 24 ? t('serverAudit.range24') : t('serverAudit.range7')}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--color-fg-subtle)]">
            {paused || remainSec == null ? t('serverAudit.pausedHint') : t('serverAudit.nextRefresh', { n: remainSec })}
          </span>
          <button type="button" className="app-chip" onClick={() => setPaused((value) => !value)}>
            {paused ? t('serverAudit.resume') : t('serverAudit.pause')}
          </button>
          <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" onClick={() => void reloadNow()}>
            {loading ? t('common.loading') : t('common.refresh')}
          </button>
          {canEdit ? (
            <button type="button" className="app-btn app-btn-primary !min-h-0 !px-3 !py-2" onClick={() => setAddOpen((open) => !open)}>
              {t('serverAudit.addManual')}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {([
          ['all', `${t('common.total')}: ${stats.total}`],
          ['fresh', `${t('serverAudit.statLive')}: ${stats.live}`],
          ['stale', `${t('serverAudit.statStale')}: ${stats.stale}`],
          ['none', `${t('serverAudit.statWait')}: ${stats.wait}`],
          ['off', t('serverAudit.filterOff')],
        ] as const).map(([id, text]) => (
          <button
            key={id}
            type="button"
            onClick={() => setParams({ status: status === id || id === 'all' ? null : id })}
            className={`app-chip ${status === id || (id === 'all' && status === 'all') ? 'app-chip--active' : ''}`}
          >
            {text}
          </button>
        ))}
      </div>

      {canEdit && addOpen ? (
        <form
          onSubmit={(event) => void onAdd(event)}
          className="chrome-glass-card p-4"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('serverAudit.pickTitle')}</h2>
            <label className="flex items-center gap-2 text-xs text-[var(--color-fg-subtle)]">
              <input
                type="checkbox"
                checked={linuxOnly}
                onChange={(event) => setLinuxOnly(event.target.checked)}
              />
              {t('serverAudit.linuxOnly')}
            </label>
          </div>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_180px_auto]">
            <div className="relative">
              <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                {t('serverAudit.hostname')}
                <input
                  value={fleetOpen ? fleetQuery : hostname || fleetQuery}
                  onFocus={() => {
                    setFleetOpen(true)
                    setFleetQuery(hostname || fleetQuery)
                  }}
                  onChange={(event) => {
                    setFleetQuery(event.target.value)
                    setHostname(event.target.value)
                    setFleetOpen(true)
                  }}
                  onBlur={() => window.setTimeout(() => setFleetOpen(false), 150)}
                  placeholder={t('serverAudit.searchFleet')}
                  className="app-input"
                  required
                  autoComplete="off"
                />
              </label>
              {fleetOpen ? (
                <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
                  {suggestions.length === 0 ? (
                    <li className="px-3 py-3 text-xs text-[var(--color-fg-subtle)]">
                      {linuxOnly && fleetItems.length > 0 ? t('serverAudit.fleetLinuxEmpty') : t('serverAudit.fleetEmpty')}
                    </li>
                  ) : (
                    suggestions.map(({ computer, enrolled }) => (
                      <li key={computer.id}>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => chooseComputer(computer)}
                          className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
                        >
                          <span className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium">{computer.hostname}</span>
                            {enrolled ? (
                              <span className="shrink-0 text-[10px] font-medium text-[var(--color-fg-subtle)]">
                                {t('serverAudit.alreadyAudited')}
                              </span>
                            ) : null}
                          </span>
                          <span className="truncate text-xs text-[var(--color-fg-subtle)]">
                            {[computer.ip_address, computer.os_name, computer.model].filter(Boolean).join(' · ') || '—'}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                  {fleetQuery.trim() && !suggestions.some((row) => row.computer.hostname.toLowerCase() === fleetQuery.trim().toLowerCase()) ? (
                    <li className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
                      {t('serverAudit.addTyped', { host: fleetQuery.trim() })}
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
              {t('serverAudit.label')}
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('serverAudit.labelPh')}
                className="app-input"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
              {t('serverAudit.interval')}
              <select
                value={intervalSec}
                onChange={(event) => setIntervalSec(Number(event.target.value))}
                className="app-input app-select"
              >
                {INTERVALS.map((value) => (
                  <option key={value} value={value}>
                    {labelFor(value)}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={busy || !hostname.trim()}
                className="app-btn app-btn-primary !min-h-0"
              >
                {t('serverAudit.add')}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
        <aside className="chrome-glass-card flex max-h-[24rem] flex-col overflow-hidden lg:sticky lg:top-3 lg:max-h-[calc(100vh-6rem)]">
          <div className="flex flex-col gap-2 border-b border-[var(--color-border)] p-3">
            <input
              value={hostQuery}
              onChange={(event) => setHostQuery(event.target.value)}
              placeholder={t('serverAudit.searchHosts')}
              className="app-input"
            />
            <div className="flex flex-wrap gap-1">
              {([
                ['temp', t('serverAudit.sortTemp')],
                ['cpu', t('serverAudit.sortCpu')],
                ['seen', t('serverAudit.sortSeen')],
                ['name', t('serverAudit.sortName')],
              ] as const).map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    if (sortKey === id) setParams({ dir: sortDir === 'desc' ? 'asc' : null })
                    else setParams({ sort: id === 'temp' ? null : id, dir: id === 'name' ? 'asc' : null })
                  }}
                  className={`app-chip !px-2.5 !py-1 ${sortKey === id ? 'app-chip--active' : ''}`}
                >
                  {text}{sortKey === id ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {loading && hosts.length === 0 ? (
              <p className="px-3 py-6 text-sm text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
            ) : hosts.length === 0 ? (
              <p className="px-3 py-6 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.empty')}</p>
            ) : visibleHosts.length === 0 ? (
              <p className="px-3 py-6 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.noMatch')}</p>
            ) : (
              visibleHosts.map((host) => {
                const tone = freshness(host)
                const active = host.id === selectedId
                return (
                  <button
                    key={host.id}
                    type="button"
                    onClick={() => setParams({ host: String(host.id) })}
                    className={`flex w-full flex-col gap-1 border-b border-[var(--color-border)] px-3 py-2.5 text-left ${active ? 'app-table-row-selected' : 'hover:bg-[var(--color-surface-muted)]'}`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{host.label || host.hostname}</span>
                      <span className={`font-mono text-sm font-semibold ${heatClass(host.latest_cpu_temp_c)}`}>{fmtTemp(host.latest_cpu_temp_c)}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2 text-xs text-[var(--color-fg-subtle)]">
                      <span className="truncate">
                        {host.hostname}
                        {host.ip_address ? ` · ${host.ip_address}` : ''}
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${host.enabled ? toneClass[tone] : toneClass.none}`}>
                        {!host.enabled ? t('serverAudit.disabled') : tone === 'fresh' ? t('serverAudit.fresh') : tone === 'stale' ? t('serverAudit.stale') : t('serverAudit.noData')}
                      </span>
                    </span>
                    <span className="flex gap-3 font-mono text-xs">
                      <span className={pctClass(host.latest_cpu_percent)}>CPU {fmtPct(host.latest_cpu_percent)}</span>
                      <span className={pctClass(host.latest_mem_percent)}>RAM {fmtPct(host.latest_mem_percent)}</span>
                      <span className={pctClass(host.latest_disk_percent)}>{t('serverAudit.disk')} {fmtPct(host.latest_disk_percent)}</span>
                      {host.latest_gpu_temp_c != null ? (
                        <span className={heatClass(host.latest_gpu_temp_c)}>GPU {fmtTemp(host.latest_gpu_temp_c)}</span>
                      ) : null}
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        <section className="flex min-w-0 flex-col gap-4">
          {!detail ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-sm text-[var(--color-fg-subtle)]">
              {t('serverAudit.select')}
            </div>
          ) : (
            <>
              <div className="chrome-glass-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{detail.label || detail.hostname}</h2>
                  <p className="text-sm text-[var(--color-fg-subtle)]">
                    {detail.hostname}
                    {detail.ip_address ? ` · ${detail.ip_address}` : ''}
                    {detail.os_summary ? ` · ${detail.os_summary}` : ''}
                    {cluster?.kind && cluster.kind !== 'standalone'
                      ? ` · ${t('serverAudit.cluster')} ${textOf(cluster.name || cluster.kind)}${cluster.role ? ` · ${textOf(cluster.role)}` : ''}`
                      : ''}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                    {detail.last_sample_at
                      ? `${t('serverAudit.lastSample')} · ${fmtWhen(detail.last_sample_at, locale)} · ${t('serverAudit.uptime')} ${fmtUptime(detail.points.at(-1)?.uptime_sec ?? numOf(asRecord(detail.payload)?.uptime_sec))}`
                      : t('serverAudit.waitingAgent')}
                    {detail.collect_requested ? ` · ${t('serverAudit.queued')}` : ''}
                  </p>
                  {detail.last_sample_at && detail.payload_in_range === false ? (
                    <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{t('serverAudit.outsideRange')}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canEdit ? (
                    <button
                      type="button"
                      disabled={busy || !detail.enabled}
                      onClick={() => void onCollect()}
                      className="app-btn app-btn-primary !min-h-0 !px-3 !py-2"
                    >
                      {t('serverAudit.collect')}
                    </button>
                  ) : null}
                  {detail.computer_id ? (
                    <Link
                      to={`/computers?computer=${detail.computer_id}`}
                      className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2 no-underline"
                    >
                      {t('serverAudit.openComputer')}
                    </Link>
                  ) : null}
                  {canEdit ? (
                    <button type="button" className={`app-chip ${panel === 'control' ? 'app-chip--active' : ''}`} onClick={() => setPanel('control')}>
                      {t('serverAudit.manage')}
                    </button>
                  ) : null}
                </div>
                </div>
              {(() => {
                const notes: { tone: string; text: string }[] = []
                if (detail.enabled && freshness(detail) === 'stale') notes.push({ tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300', text: t('serverAudit.stale') })
                if (failed.length > 0) notes.push({ tone: 'border-rose-500/40 text-rose-700 dark:text-rose-300', text: `${t('serverAudit.failed')}: ${failed.length}` })
                if (packages?.reboot_required) notes.push({ tone: 'border-amber-500/40 text-amber-700 dark:text-amber-300', text: t('serverAudit.reboot') })
                if (timeInfo?.ntp_synchronized === false) notes.push({ tone: 'border-rose-500/40 text-rose-700 dark:text-rose-300', text: `NTP · ${t('serverAudit.ntpOff')}` })
                if (notes.length === 0) return null
                return (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {notes.map((note) => (
                      <span key={note.text} className={`rounded-full border px-2.5 py-1 text-xs font-medium ${note.tone}`}>{note.text}</span>
                    ))}
                  </div>
                )
              })()}
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                <Meter label={t('serverAudit.temp')} value={fmtTemp(detail.latest_cpu_temp_c)} ratio={tempRatio(detail.latest_cpu_temp_c)} valueClass={heatClass(detail.latest_cpu_temp_c)} barClass={heatBar(detail.latest_cpu_temp_c)} />
                <Meter label={t('serverAudit.gpu')} value={fmtTemp(gpuNow)} hint={gpuHint} ratio={tempRatio(gpuNow)} valueClass={heatClass(gpuNow)} barClass={heatBar(gpuNow)} />
                <Meter label={t('serverAudit.cpu')} value={fmtPct(detail.latest_cpu_percent)} ratio={(detail.latest_cpu_percent ?? 0) / 100} valueClass={pctClass(detail.latest_cpu_percent)} barClass={pctBar(detail.latest_cpu_percent)} />
                <Meter label={t('serverAudit.memory')} value={fmtPct(detail.latest_mem_percent)} ratio={(detail.latest_mem_percent ?? 0) / 100} valueClass={pctClass(detail.latest_mem_percent)} barClass={pctBar(detail.latest_mem_percent)} />
                <Meter label={t('serverAudit.disk')} value={fmtPct(diskPct)} hint={diskHint} ratio={(diskPct ?? 0) / 100} valueClass={pctClass(diskPct)} barClass={pctBar(diskPct)} />
                <Meter label={t('serverAudit.load')} value={detail.latest_load_1 == null ? '—' : detail.latest_load_1.toFixed(2)} hint={`${t('serverAudit.cores')} ${cores}`} ratio={Math.min(loadRatio(detail.latest_load_1, cores), 1)} valueClass={loadClass(detail.latest_load_1, cores)} barClass={loadBar(detail.latest_load_1, cores)} />
              </div>

              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => setPanel('charts')} className={`app-chip ${panel === 'charts' ? 'app-chip--active' : ''}`}>{t('serverAudit.chartsTab')}</button>
                <button type="button" onClick={() => setPanel('sensors')} className={`app-chip ${panel === 'sensors' ? 'app-chip--active' : ''}`}>{t('serverAudit.sensors')}</button>
                <button type="button" onClick={() => setPanel('lists')} className={`app-chip ${panel === 'lists' ? 'app-chip--active' : ''}`}>{t('serverAudit.lists')}</button>
                <button type="button" onClick={() => setPanel('journal')} className={`app-chip ${panel === 'journal' ? 'app-chip--active' : ''}`}>{t('serverAudit.logs')}</button>
                {canEdit ? (
                  <button type="button" onClick={() => setPanel('control')} className={`app-chip ${panel === 'control' ? 'app-chip--active' : ''}`}>{t('serverAudit.manage')}</button>
                ) : null}
              </div>

              {panel === 'charts' ? (
              <div className="flex flex-col gap-3" onMouseLeave={() => setHoverMs(null)}>
                <div className="flex flex-wrap gap-2 text-xs text-[var(--color-fg-subtle)]">
                  <span className="app-chip">{t('serverAudit.load')} {textOf(loadInfo?.['1'] ?? detail.latest_load_1)} / {textOf(loadInfo?.['5'])} / {textOf(loadInfo?.['15'])}</span>
                  <span className="app-chip">{t('serverAudit.memory')} {fmtPct(numOf(memory?.used_percent))} · {t('serverAudit.cached')} {textOf(memory?.cached_mb)} MB · {t('serverAudit.available')} {textOf(memory?.available_mb)} MB</span>
                  <span className="app-chip">{t('serverAudit.cluster')} {cluster?.kind && cluster.kind !== 'standalone' ? `${textOf(cluster.kind)}${cluster.name ? ` · ${textOf(cluster.name)}` : ''}` : t('serverAudit.clusterStandalone')}</span>
                </div>
                {perCore.length > 0 ? (
                  <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div className="mb-2 text-sm font-semibold">{t('serverAudit.perCore')}</div>
                    <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(2.4rem, 1fr))' }}>
                      {perCore.map((value, index) => (
                        <div key={index} title={`${index}: ${value.toFixed(0)}%`} className="flex h-10 items-end overflow-hidden rounded-sm bg-[var(--color-bg-muted)]">
                          <div className={`w-full ${pctBar(value)}`} style={{ height: `${Math.max(4, Math.min(100, value))}%` }} />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              <div className="grid gap-3 xl:grid-cols-2">
                <ChartFrame title={t('serverAudit.chartTemp')}>
                  {tempSeries.length > 0 ? (
                    <ServerAuditCharts times={times} unit="temp" series={tempSeries} locale={locale} hoverMs={hoverMs} onHover={setHoverMs} threshold={80} />
                  ) : (
                    <ChartEmpty>{t('serverAudit.chartNeed')}</ChartEmpty>
                  )}
                </ChartFrame>
                <ChartFrame title={t('serverAudit.chartUse')}>
                  {times.length > 0 ? (
                    <ServerAuditCharts
                      times={times}
                      unit="percent"
                      locale={locale}
                      hoverMs={hoverMs}
                      onHover={setHoverMs}
                      threshold={90}
                      series={[
                        { label: t('serverAudit.cpu'), color: '#2563eb', data: detail.points.map((point) => point.cpu_used_percent) },
                        { label: t('serverAudit.memory'), color: '#059669', data: detail.points.map((point) => point.mem_used_percent) },
                        { label: t('serverAudit.disk'), color: '#d97706', data: detail.points.map((point) => point.disk_used_percent) },
                      ]}
                    />
                  ) : (
                    <ChartEmpty>{t('serverAudit.chartNeed')}</ChartEmpty>
                  )}
                </ChartFrame>
                <ChartFrame title={t('serverAudit.chartNet')}>
                  {times.length > 0 ? (
                    <ServerAuditCharts
                      times={times}
                      unit="rate"
                      locale={locale}
                      hoverMs={hoverMs}
                      onHover={setHoverMs}
                      series={[
                        { label: t('serverAudit.rx'), color: '#0284c7', data: detail.points.map((point) => point.net_rx_bps) },
                        { label: t('serverAudit.tx'), color: '#7c3aed', data: detail.points.map((point) => point.net_tx_bps) },
                      ]}
                    />
                  ) : (
                    <ChartEmpty>{t('serverAudit.chartNeed')}</ChartEmpty>
                  )}
                </ChartFrame>
                <ChartFrame title={t('serverAudit.chartLoad')}>
                  {times.length > 0 ? (
                    <ServerAuditCharts
                      times={times}
                      unit="load"
                      locale={locale}
                      hoverMs={hoverMs}
                      onHover={setHoverMs}
                      series={[{ label: t('serverAudit.load'), color: '#475569', data: detail.points.map((point) => point.load_1) }]}
                    />
                  ) : (
                    <ChartEmpty>{t('serverAudit.chartNeed')}</ChartEmpty>
                  )}
                </ChartFrame>
              </div>
              </div>
              ) : null}

              {panel === 'sensors' ? (
              <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{t('serverAudit.sensors')}</h3>
                  <input
                    value={sensorQuery}
                    onChange={(event) => setSensorQuery(event.target.value)}
                    placeholder={t('serverAudit.sensorPh')}
                    className="app-input w-full sm:w-56"
                  />
                </div>
                {gpus.length > 0 ? (
                  <div className="mb-3 grid gap-2 md:grid-cols-2">
                    {gpus.map((gpu, index) => {
                      const used = numOf(gpu.mem_used_mb)
                      const total = numOf(gpu.mem_total_mb)
                      const temp = numOf(gpu.temp_c)
                      return (
                        <div key={`${textOf(gpu.index)}-${index}`} className="rounded-xl border border-violet-400/40 bg-violet-500/5 p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-[11px] font-medium uppercase tracking-wide text-violet-600 dark:text-violet-300">{t('serverAudit.gpu')}</div>
                              <div className="truncate text-sm font-medium">{textOf(gpu.name)}</div>
                            </div>
                            <div className={`font-mono text-2xl font-semibold tabular-nums ${heatClass(temp)}`}>{fmtTemp(temp)}</div>
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--color-fg-subtle)] sm:grid-cols-4">
                            <span>{t('serverAudit.cpu')} {fmtPct(numOf(gpu.util_percent))}</span>
                            <span>{t('serverAudit.vram')} {used == null ? '—' : `${Math.round(used)} / ${total == null ? '—' : Math.round(total)} MB`}</span>
                            <span>{t('serverAudit.power')} {numOf(gpu.power_w) == null ? '—' : `${numOf(gpu.power_w)?.toFixed(0)} W`}</span>
                            <span>{t('serverAudit.fan')} {numOf(gpu.fan_percent) == null ? '—' : fmtPct(numOf(gpu.fan_percent))}</span>
                          </div>
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                            <div className={`h-full rounded-full ${heatBar(temp)}`} style={{ width: `${Math.max(0, Math.min(100, temp ?? 0))}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
                {rankedTemps.length === 0 ? (
                  <p className="text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.noTemp')}</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {rankedTemps.map((row, index) => {
                      const kind = sensorKind(row)
                      const meta = row.max != null || row.crit != null
                        ? `${fmtTemp(numOf(row.max))} / ${fmtTemp(numOf(row.crit))}`
                        : textOf(row.source)
                      return (
                        <SensorCard
                          key={`${textOf(row.name)}-${index}`}
                          name={textOf(row.name)}
                          value={numOf(row.celsius)}
                          meta={kind === 'gpu' ? `${t('serverAudit.gpu')} · ${meta}` : meta}
                          kind={kind}
                        />
                      )
                    })}
                  </div>
                )}
                {fans.length > 0 || shownVolts.length > 0 ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {fans.map((row, index) => (
                      <span key={`fan-${index}`} className="rounded-full bg-[var(--color-bg-muted)] px-2.5 py-1 text-xs">
                        {textOf(row.name)} · {textOf(row.rpm)} rpm
                      </span>
                    ))}
                    {shownVolts.map((row, index) => (
                      <span key={`volt-${index}`} className="rounded-full bg-[var(--color-bg-muted)] px-2.5 py-1 text-xs">
                        {textOf(row.name)} · {textOf(row.volts)} V
                      </span>
                    ))}
                  </div>
                ) : null}
              </section>
              ) : null}

              {panel === 'journal' ? (
              <JournalPanel
                logs={logs}
                mode={logMode}
                onMode={setLogMode}
                locale={locale}
                title={t('serverAudit.logs')}
                allLabel={t('serverAudit.logsAll')}
                errorsLabel={t('serverAudit.logsErrors')}
                emptyLabel={t('serverAudit.logsEmpty')}
                noErrorsLabel={t('serverAudit.logsNoErrors')}
                sourceLabel={logSource ? t('serverAudit.logsSource', { source: logSource }) : ''}
              />
              ) : null}

              {panel === 'lists' ? (
              <div className="flex flex-col gap-3">
                <Fold title={t('serverAudit.disks')} count={disks.length} open>
                  {disks.length === 0 ? (
                    <Empty>—</Empty>
                  ) : (
                    <div className="flex flex-col gap-3 p-3">
                      {disks.map((row, index) => {
                        const used = numOf(row.used_percent) ?? 0
                        return (
                          <div key={`${textOf(row.mount)}-${index}`}>
                            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                              <span className="truncate font-medium">{textOf(row.mount)}{row.model ? ` · ${textOf(row.model)}` : ''}</span>
                              <span className="shrink-0 text-[var(--color-fg-subtle)]">
                                {fmtPct(numOf(row.used_percent))} · {textOf(row.free_gb)} {t('serverAudit.free')}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                              <div className={`h-full rounded-full ${used >= 90 ? 'bg-rose-500' : used >= 75 ? 'bg-amber-500' : 'bg-[var(--color-primary)]'}`} style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  {diskIo.length > 0 ? (
                    <div className="border-t border-[var(--color-border)]">
                      <div className="px-3 pt-2 text-xs font-medium text-[var(--color-fg-subtle)]">{t('serverAudit.diskIo')}</div>
                      <SimpleTable
                        head={[t('serverAudit.name'), t('serverAudit.read'), t('serverAudit.write')]}
                        rows={diskIo.map((row) => [
                          textOf(row.name || row.model),
                          fmtRate(numOf(row.read_bps)),
                          fmtRate(numOf(row.write_bps)),
                        ])}
                      />
                    </div>
                  ) : null}
                </Fold>
                <Fold title={t('serverAudit.network')} count={network.length} open>
                  <SimpleTable
                    head={[t('serverAudit.name'), 'IPv4', '', `${t('serverAudit.rx')} / ${t('serverAudit.tx')}`]}
                    rows={network.map((row) => [
                      textOf(row.name),
                      textOf(row.ipv4),
                      textOf(row.operstate),
                      `${fmtRate(numOf(row.rx_bps))} / ${fmtRate(numOf(row.tx_bps))}`,
                    ])}
                  />
                </Fold>
                <Fold title={t('serverAudit.processes')} count={processes.length}>
                  <SimpleTable
                    head={['PID', t('serverAudit.user'), 'CPU', 'RAM', t('serverAudit.name')]}
                    rows={processes.map((row) => [
                      textOf(row.pid),
                      textOf(row.user),
                      fmtPct(numOf(row.cpu)),
                      numOf(row.rss_mb) == null ? '—' : `${numOf(row.rss_mb)?.toFixed(0)} MB`,
                      textOf(row.name),
                    ])}
                  />
                </Fold>
                <Fold title={t('serverAudit.listeners')} count={listeners.length}>
                  <SimpleTable head={['', '']} rows={listeners.map((row) => [textOf(row.proto), textOf(row.address)])} />
                </Fold>
                <Fold title={t('serverAudit.docker')} count={docker.length} open={docker.length > 0}>
                  {docker.length === 0 ? (
                    <Empty>—</Empty>
                  ) : (
                    <SimpleTable
                      head={[t('serverAudit.name'), '', '']}
                      rows={docker.map((row) => [textOf(row.name), textOf(row.status), textOf(row.image)])}
                    />
                  )}
                </Fold>
                <Fold title={t('serverAudit.failed')} count={failed.length} open={failed.length > 0}>
                  {failed.length === 0 ? (
                    <Empty>{t('serverAudit.noFailed')}</Empty>
                  ) : (
                    <SimpleTable rows={failed.map((row) => [textOf(row.name), textOf(row.sub)])} />
                  )}
                </Fold>
                <Fold title={t('serverAudit.sessions')} count={sessions.length}>
                  {sessions.length === 0 ? (
                    <Empty>—</Empty>
                  ) : (
                    <SimpleTable rows={sessions.map((row) => [textOf(row.user), textOf(row.host || row.tty || '')])} />
                  )}
                </Fold>
              <div className="grid gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm md:grid-cols-2">
                <Info label={t('serverAudit.cores')} value={textOf(cpu?.cores)} extra={textOf(cpu?.model)} />
                <Info label={t('serverAudit.virt')} value={textOf(os?.virt)} extra={textOf(os?.kernel)} />
                <Info
                  label={t('serverAudit.packages')}
                  value={textOf(packages?.installed)}
                  extra={
                    packages?.reboot_required
                      ? t('serverAudit.reboot')
                      : packages?.updates != null
                        ? t('serverAudit.updates', { n: String(packages.updates) })
                        : ''
                  }
                />
                <Info
                  label="NTP"
                  value={timeInfo?.ntp_synchronized === true ? t('serverAudit.ntpOn') : timeInfo?.ntp_synchronized === false ? t('serverAudit.ntpOff') : '—'}
                />
                <Info
                  label={t('serverAudit.pressure')}
                  value={`cpu ${textOf(pressure?.cpu)} · ram ${textOf(pressure?.memory)} · io ${textOf(pressure?.io)}`}
                />
                <Info
                  label={t('serverAudit.sockets')}
                  value={`tcp ${textOf(sockets?.tcp_inuse)} · udp ${textOf(sockets?.udp_inuse)}`}
                />
                <Info
                  label={t('serverAudit.files')}
                  value={`${textOf(files?.allocated)} / ${textOf(files?.max)}`}
                />
                <Info
                  label={t('serverAudit.clusterRole')}
                  value={cluster?.role ? textOf(cluster.role) : t('serverAudit.clusterStandalone')}
                  extra={textOf(cluster?.name || cluster?.kind)}
                />
              </div>
              </div>
              ) : null}

              {panel === 'control' && canEdit ? (
                <div className="chrome-glass-card grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                  <form onSubmit={(event) => void onLabel(event)} className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)] sm:col-span-2 xl:col-span-4">
                    {t('serverAudit.rename')}
                    <span className="font-normal">{t('serverAudit.manageHint')}</span>
                    <div className="flex flex-wrap gap-2">
                      <input value={draftLabel} onChange={(event) => setDraftLabel(event.target.value)} placeholder={t('serverAudit.labelPh')} className="app-input min-w-[12rem] flex-1" />
                      <button type="submit" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2">{t('serverAudit.saveLabel')}</button>
                    </div>
                    <span className="mt-2 font-medium">{t('serverAudit.hostNotes')}</span>
                    <textarea value={draftNotes} onChange={(event) => setDraftNotes(event.target.value)} rows={3} className="app-input min-h-[4.5rem] resize-y" />
                  </form>
                  <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                    {t('serverAudit.interval')}
                    <select value={intervalSecOf(detail)} onChange={(event) => void onInterval(Number(event.target.value))} className="app-input app-select">
                      {INTERVALS.map((value) => (
                        <option key={value} value={value}>{labelFor(value)}</option>
                      ))}
                    </select>
                    {intervalSecOf(detail) > 0 && intervalSecOf(detail) < 60 ? (
                      <span className="font-normal">{t('serverAudit.intervalFast')}</span>
                    ) : null}
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                    {t('serverAudit.journalCollect')}
                    <select value={detail.journal_mode || 'errors'} onChange={(event) => void onJournal({ journal_mode: event.target.value as 'off' | 'errors' | 'all' })} className="app-input app-select">
                      <option value="off">{t('serverAudit.journalCollectOff')}</option>
                      <option value="errors">{t('serverAudit.journalCollectErrors')}</option>
                      <option value="all">{t('serverAudit.journalCollectAll')}</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                    {t('serverAudit.journalLines')}
                    <select value={detail.journal_lines || 20} onChange={(event) => void onJournal({ journal_lines: Number(event.target.value) })} className="app-input app-select">
                      {[0, 10, 20, 40, 80].map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                    {t('serverAudit.retain')}
                    <select value={detail.retain_days || 14} onChange={(event) => void onJournal({ retain_days: Number(event.target.value) })} className="app-input app-select">
                      {[7, 14, 30, 90].map((n) => (
                        <option key={n} value={n}>{t('serverAudit.retainDays', { n })}</option>
                      ))}
                    </select>
                  </label>
                  <div className="flex flex-wrap items-end gap-2 sm:col-span-2 xl:col-span-4">
                    <button type="button" onClick={() => void onToggle()} className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2">
                      {detail.enabled ? t('serverAudit.enabled') : t('serverAudit.disabled')}
                    </button>
                    <button type="button" onClick={() => void onDelete(detail)} className="app-btn app-btn-danger !min-h-0 !px-3 !py-2">
                      {t('serverAudit.remove')}
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function Meter({
  label,
  value,
  hint,
  ratio,
  valueClass,
  barClass,
}: {
  label: string
  value: string
  hint?: string
  ratio: number
  valueClass: string
  barClass: string
}) {
  const width = Math.max(0, Math.min(100, ratio * 100))
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="mt-0.5 h-4 truncate text-[11px] text-[var(--color-fg-subtle)]">{hint || ' '}</div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
        <div className={`h-full rounded-full ${barClass}`} style={{ width: `${width}%` }} />
      </div>
    </div>
  )
}

function ChartFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
      <h3 className="px-1 pb-2 text-sm font-semibold">{title}</h3>
      <div className="h-56">{children}</div>
    </section>
  )
}

function ChartEmpty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">{children}</div>
}

function SensorCard({
  name,
  value,
  meta,
  kind,
}: {
  name: string
  value: number | null
  meta: string
  kind: string
}) {
  const width = value == null ? 0 : Math.max(4, Math.min(100, value))
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${kind === 'gpu' ? 'border-violet-400/50 bg-violet-500/5' : 'border-[var(--color-border)] bg-[var(--color-bg)]'}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-[var(--color-fg-subtle)]">{name}</span>
        <span className={`font-mono text-sm font-semibold tabular-nums ${heatClass(value)}`}>{fmtTemp(value)}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
        <div className={`h-full rounded-full ${heatBar(value)}`} style={{ width: `${width}%` }} />
      </div>
      <div className="mt-1 truncate text-[10px] text-[var(--color-fg-subtle)]">{meta}</div>
    </div>
  )
}

function Fold({
  title,
  count,
  open = false,
  children,
}: {
  title: string
  count?: number
  open?: boolean
  children: React.ReactNode
}) {
  const [shown, setShown] = useState(open)
  useEffect(() => {
    setShown(open)
  }, [open])
  return (
    <details
      open={shown}
      onToggle={(event) => setShown(event.currentTarget.open)}
      className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span className="flex items-center justify-between gap-3">
          <span>
            {title}
            {count != null ? <span className="ml-2 font-normal text-[var(--color-fg-subtle)]">{count}</span> : null}
          </span>
          <span aria-hidden className="text-xs text-[var(--color-fg-subtle)]">▾</span>
        </span>
      </summary>
      <div className="max-h-72 overflow-auto border-t border-[var(--color-border)]">{children}</div>
    </details>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-4 text-sm text-[var(--color-fg-subtle)]">{children}</p>
}

function SimpleTable({ head, rows }: { head?: string[]; rows: string[][] }) {
  if (rows.length === 0) return <Empty>—</Empty>
  return (
    <table className="w-full text-left text-xs">
      {head ? (
        <thead className="text-[var(--color-fg-subtle)]">
          <tr>
            {head.map((cell) => (
              <th key={cell} className="px-3 py-1.5 font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
      ) : null}
      <tbody>
        {rows.map((row, index) => (
          <tr key={index} className="border-t border-[var(--color-border)]">
            {row.map((cell, cellIndex) => (
              <td key={cellIndex} className="max-w-[220px] truncate px-3 py-1.5">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function JournalPanel({
  logs,
  mode,
  onMode,
  locale,
  title,
  allLabel,
  errorsLabel,
  emptyLabel,
  noErrorsLabel,
  sourceLabel,
}: {
  logs: Record<string, unknown>[]
  mode: 'err' | 'all'
  onMode: (mode: 'err' | 'all') => void
  locale: string
  title: string
  allLabel: string
  errorsLabel: string
  emptyLabel: string
  noErrorsLabel: string
  sourceLabel: string
}) {
  const errors = logs.filter((row) => isLogError(String(row.level || '')))
  const shown = mode === 'err' ? errors : logs
  return (
    <section className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {sourceLabel ? <span className="text-xs text-[var(--color-fg-subtle)]">{sourceLabel}</span> : null}
          <button type="button" onClick={() => onMode('err')} className={`app-chip !px-2.5 !py-1 ${mode === 'err' ? 'app-chip--active' : ''}`}>
            {errorsLabel} ({errors.length})
          </button>
          <button type="button" onClick={() => onMode('all')} className={`app-chip !px-2.5 !py-1 ${mode === 'all' ? 'app-chip--active' : ''}`}>
            {allLabel} ({logs.length})
          </button>
        </div>
      </div>
      {logs.length === 0 ? (
        <Empty>{emptyLabel}</Empty>
      ) : shown.length === 0 ? (
        <Empty>{noErrorsLabel}</Empty>
      ) : (
        <ul className="max-h-80 overflow-auto font-mono text-xs">
          {shown.map((row, index) => {
            const level = String(row.level || 'info')
            const tone = isLogError(level)
              ? 'text-red-600'
              : level === 'warning'
                ? 'text-amber-600'
                : 'text-[var(--color-fg-subtle)]'
            return (
              <li key={`${textOf(row.at)}-${index}`} className="border-t border-[var(--color-border)] px-3 py-1.5">
                <span className={tone}>{level}</span>
                <span className="text-[var(--color-fg-subtle)]">
                  {row.at ? ` ${fmtWhen(String(row.at), locale)}` : ''}
                  {row.unit ? ` ${textOf(row.unit)}` : ''}
                </span>
                <div className="whitespace-pre-wrap break-all text-[var(--color-fg)]">{textOf(row.text)}</div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Info({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{label}</div>
      <div className="font-medium">{value}</div>
      {extra ? <div className="truncate text-xs text-[var(--color-fg-subtle)]">{extra}</div> : null}
    </div>
  )
}
