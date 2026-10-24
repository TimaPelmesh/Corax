import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Computer, type ServerAuditDetail, type ServerAuditHost } from '../api'
import { useAuth } from '../AuthContext'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { ServerAuditCharts } from './ServerAuditCharts'

const INTERVALS = [0, 5, 15, 30, 60, 180, 360, 720, 1440] as const

type Hours = 6 | 24 | 168

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

function freshness(host: ServerAuditHost): 'fresh' | 'stale' | 'none' {
  if (!host.last_sample_at) return 'none'
  const age = Date.now() - new Date(host.last_sample_at).getTime()
  const windowMin = Math.max((host.interval_minutes || 0) * 2, 20)
  if (!Number.isFinite(age) || age < 0) return 'fresh'
  return age <= windowMin * 60_000 ? 'fresh' : 'stale'
}

export function ServerAuditPage() {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const { user } = useAuth()
  const confirm = useConfirmDialog()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')

  const [hosts, setHosts] = useState<ServerAuditHost[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<ServerAuditDetail | null>(null)
  const [hours, setHours] = useState<Hours>(24)
  const [loading, setLoading] = useState(true)
  const [hostname, setHostname] = useState('')
  const [label, setLabel] = useState('')
  const [interval, setIntervalMinutes] = useState(15)
  const [busy, setBusy] = useState(false)
  const [fleetQuery, setFleetQuery] = useState('')
  const [fleetOpen, setFleetOpen] = useState(false)
  const [fleetItems, setFleetItems] = useState<Computer[]>([])
  const [linuxOnly, setLinuxOnly] = useState(true)
  const [logMode, setLogMode] = useState<'err' | 'all'>('err')
  const [hostQuery, setHostQuery] = useState('')
  const [status, setStatus] = useState<'all' | 'fresh' | 'stale' | 'none' | 'off'>('all')
  const [sortKey, setSortKey] = useState<'name' | 'temp' | 'cpu' | 'seen'>('temp')
  const [sensorQuery, setSensorQuery] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const loadHosts = useCallback(async () => {
    const rows = await api.serverAuditHosts()
    setHosts(rows)
    setSelectedId((current) => current ?? rows[0]?.id ?? null)
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
  }, [selectedId])

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

  useEffect(() => {
    if (selectedId == null) {
      setDetail(null)
      return
    }
    let alive = true
    loadDetail(selectedId, hours).catch((error: unknown) => {
      if (alive) toast.error(error instanceof Error ? error.message : t('common.error'))
    })
    const timer = window.setInterval(() => {
      void loadDetail(selectedId, hours).catch(() => undefined)
      void loadHosts().catch(() => undefined)
    }, hurry ? 8000 : 20000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [hours, hurry, loadDetail, loadHosts, selectedId, t, toast])

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
      if (sortKey === 'temp') return (b.latest_cpu_temp_c ?? -1) - (a.latest_cpu_temp_c ?? -1)
      if (sortKey === 'cpu') return (b.latest_cpu_percent ?? -1) - (a.latest_cpu_percent ?? -1)
      if (sortKey === 'seen') return (b.last_sample_at || '').localeCompare(a.last_sample_at || '')
      return (a.label || a.hostname).localeCompare(b.label || b.hostname, locale === 'en' ? 'en' : 'ru')
    })
    return rows
  }, [hostQuery, hosts, locale, sortKey, status])

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

  const labels = useMemo(
    () => (detail?.points ?? []).map((point) => fmtWhen(point.collected_at, locale)),
    [detail?.points, locale],
  )

  function chooseComputer(computer: Computer) {
    const existing = hosts.find((host) => host.hostname.toLowerCase() === computer.hostname.toLowerCase())
    if (existing) {
      setSelectedId(existing.id)
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
        interval_minutes: interval,
      })
      setHostname('')
      setLabel('')
      setFleetQuery('')
      toast.ok(t('serverAudit.added'))
      await loadHosts()
      setSelectedId(created.id)
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
      const updated = await api.updateServerAuditHost(detail.id, { interval_minutes: next })
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
      if (selectedId === host.id) setSelectedId(rows.find((row) => row.id !== host.id)?.id ?? rows[0]?.id ?? null)
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
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      {confirm.dialog}
      <header className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap gap-1">
          {([6, 24, 168] as Hours[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setHours(value)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${hours === value ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)]'}`}
            >
              {value === 6 ? t('serverAudit.range6') : value === 24 ? t('serverAudit.range24') : t('serverAudit.range7')}
            </button>
          ))}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setAddOpen((open) => !open)}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
          >
            {t('serverAudit.addManual')}
          </button>
        ) : null}
      </header>

      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {t('common.total')}: <strong>{stats.total}</strong>
        </span>
        <span className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-emerald-800 dark:text-emerald-200">
          {t('serverAudit.statLive')}: <strong>{stats.live}</strong>
        </span>
        <span className="rounded-lg bg-amber-500/10 px-3 py-1.5 text-amber-800 dark:text-amber-200">
          {t('serverAudit.statStale')}: <strong>{stats.stale}</strong>
        </span>
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {t('serverAudit.statWait')}: <strong>{stats.wait}</strong>
        </span>
      </div>

      {canEdit && addOpen ? (
        <form
          onSubmit={(event) => void onAdd(event)}
          className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
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
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
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
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
              {t('serverAudit.interval')}
              <select
                value={interval}
                onChange={(event) => setIntervalMinutes(Number(event.target.value))}
                className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
              >
                {INTERVALS.map((value) => (
                  <option key={value} value={value}>
                    {value === 0 ? t('serverAudit.manual') : t('serverAudit.every', { n: value })}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                disabled={busy || !hostname.trim()}
                className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('serverAudit.add')}
              </button>
            </div>
          </div>
        </form>
      ) : null}

      <div className="flex flex-col gap-4">
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={hostQuery}
              onChange={(event) => setHostQuery(event.target.value)}
              placeholder={t('serverAudit.searchHosts')}
              className="min-w-[12rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:max-w-xs"
            />
            <div className="flex flex-wrap gap-1">
              {([
                ['all', t('serverAudit.filterAll')],
                ['fresh', t('serverAudit.filterLive')],
                ['none', t('serverAudit.filterWait')],
                ['stale', t('serverAudit.filterStale')],
                ['off', t('serverAudit.filterOff')],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setStatus(id)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${status === id ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)]'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <select
              value={sortKey}
              onChange={(event) => setSortKey(event.target.value as 'name' | 'temp' | 'cpu' | 'seen')}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            >
              <option value="temp">{t('serverAudit.sortTemp')}</option>
              <option value="cpu">{t('serverAudit.sortCpu')}</option>
              <option value="seen">{t('serverAudit.sortSeen')}</option>
              <option value="name">{t('serverAudit.sortName')}</option>
            </select>
            <button
              type="button"
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
              onClick={() => void loadHosts().catch((error: unknown) => toast.error(error instanceof Error ? error.message : t('common.error')))}
            >
              {loading ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
          {hosts.length === 0 ? (
            <p className="px-3 py-6 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.empty')}</p>
          ) : visibleHosts.length === 0 ? (
            <p className="px-3 py-6 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.noMatch')}</p>
          ) : (
            <div className="app-table-shell overflow-x-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
              <table className="app-table min-w-full text-left text-sm">
                <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-[13px] font-medium text-[var(--color-fg-subtle)]">
                  <tr>
                    <th className="px-3 py-2.5">{t('serverAudit.hostname')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.temp')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.gpu')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.cpu')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.memory')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.disk')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.load')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.interval')}</th>
                    <th className="px-3 py-2.5">{t('serverAudit.lastSample')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHosts.map((host) => {
                    const tone = freshness(host)
                    const active = host.id === selectedId
                    return (
                      <tr
                        key={host.id}
                        onClick={() => setSelectedId(host.id)}
                        className={`cursor-pointer border-t border-[var(--color-border)] ${active ? 'bg-[var(--color-bg-muted)]' : 'hover:bg-[var(--color-bg-muted)]/70'}`}
                      >
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{host.label || host.hostname}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${host.enabled ? toneClass[tone] : toneClass.none}`}>
                              {!host.enabled ? t('serverAudit.disabled') : tone === 'fresh' ? t('serverAudit.fresh') : tone === 'stale' ? t('serverAudit.stale') : t('serverAudit.noData')}
                            </span>
                          </div>
                          <div className="truncate text-xs text-[var(--color-fg-subtle)]">
                            {host.hostname}
                            {host.ip_address ? ` · ${host.ip_address}` : ''}
                          </div>
                        </td>
                        <td className={`px-3 py-2.5 font-mono ${heatClass(host.latest_cpu_temp_c)}`}>
                          {fmtTemp(host.latest_cpu_temp_c)}
                        </td>
                        <td className={`px-3 py-2.5 font-mono ${heatClass(host.latest_gpu_temp_c)}`}>
                          {fmtTemp(host.latest_gpu_temp_c)}
                        </td>
                        <td className="px-3 py-2.5 font-mono">{fmtPct(host.latest_cpu_percent)}</td>
                        <td className="px-3 py-2.5 font-mono">{fmtPct(host.latest_mem_percent)}</td>
                        <td className="px-3 py-2.5 font-mono">{fmtPct(host.latest_disk_percent)}</td>
                        <td className="px-3 py-2.5 font-mono">{host.latest_load_1 == null ? '—' : host.latest_load_1.toFixed(2)}</td>
                        <td className="px-3 py-2.5 text-[var(--color-fg-subtle)]">
                          {host.interval_minutes ? t('serverAudit.every', { n: host.interval_minutes }) : t('serverAudit.manual')}
                        </td>
                        <td className="px-3 py-2.5 text-[var(--color-fg-subtle)]">{fmtWhen(host.last_sample_at, locale)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-4">
          {!detail ? (
            <div className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-10 text-sm text-[var(--color-fg-subtle)]">
              {t('serverAudit.select')}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-semibold">{detail.label || detail.hostname}</h2>
                  <p className="text-sm text-[var(--color-fg-subtle)]">
                    {detail.hostname}
                    {detail.ip_address ? ` · ${detail.ip_address}` : ''}
                    {detail.os_summary ? ` · ${detail.os_summary}` : ''}
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
                    <>
                      <select
                        value={detail.interval_minutes}
                        onChange={(event) => void onInterval(Number(event.target.value))}
                        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-2 text-sm"
                      >
                        {INTERVALS.map((value) => (
                          <option key={value} value={value}>
                            {value === 0 ? t('serverAudit.manual') : t('serverAudit.every', { n: value })}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={() => void onToggle()} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
                        {detail.enabled ? t('serverAudit.enabled') : t('serverAudit.disabled')}
                      </button>
                      <button
                        type="button"
                        disabled={busy || !detail.enabled}
                        onClick={() => void onCollect()}
                        className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                      >
                        {t('serverAudit.collect')}
                      </button>
                      <button
                        type="button"
                        onClick={() => void onDelete(detail)}
                        className="rounded-lg border border-red-500/40 px-3 py-2 text-sm text-red-600"
                      >
                        {t('serverAudit.remove')}
                      </button>
                    </>
                  ) : null}
                  {detail.computer_id ? (
                    <Link
                      to={`/computers?computer=${detail.computer_id}`}
                      className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm no-underline hover:bg-[var(--color-bg-muted)]"
                    >
                      {t('serverAudit.openComputer')}
                    </Link>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                <Meter label={t('serverAudit.temp')} value={fmtTemp(detail.latest_cpu_temp_c)} ratio={(detail.latest_cpu_temp_c ?? 0) / 100} valueClass={heatClass(detail.latest_cpu_temp_c)} barClass={heatBar(detail.latest_cpu_temp_c)} />
                <Meter label={t('serverAudit.gpu')} value={fmtTemp(gpuNow)} hint={gpuHint} ratio={(gpuNow ?? 0) / 100} valueClass={heatClass(gpuNow)} barClass={heatBar(gpuNow)} />
                <Meter label={t('serverAudit.cpu')} value={fmtPct(detail.latest_cpu_percent)} ratio={(detail.latest_cpu_percent ?? 0) / 100} valueClass="text-[var(--color-fg)]" barClass="bg-sky-500" />
                <Meter label={t('serverAudit.memory')} value={fmtPct(detail.latest_mem_percent)} ratio={(detail.latest_mem_percent ?? 0) / 100} valueClass="text-[var(--color-fg)]" barClass="bg-emerald-500" />
                <Meter label={t('serverAudit.disk')} value={fmtPct(detail.latest_disk_percent)} ratio={(detail.latest_disk_percent ?? 0) / 100} valueClass="text-[var(--color-fg)]" barClass="bg-amber-500" />
                <Meter label={t('serverAudit.load')} value={detail.latest_load_1 == null ? '—' : detail.latest_load_1.toFixed(2)} ratio={Math.min((detail.latest_load_1 ?? 0) / 8, 1)} valueClass="text-[var(--color-fg)]" barClass="bg-slate-500" />
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <ChartFrame title={t('serverAudit.chartTemp')}>
                  {tempSeries.length > 0 ? (
                    <ServerAuditCharts labels={labels} unit="temp" series={tempSeries} />
                  ) : (
                    <ChartEmpty>{t('serverAudit.chartNeed')}</ChartEmpty>
                  )}
                </ChartFrame>
                <ChartFrame title={t('serverAudit.chartUse')}>
                  {labels.length > 0 ? (
                    <ServerAuditCharts
                      labels={labels}
                      unit="percent"
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
                  {labels.length > 0 ? (
                    <ServerAuditCharts
                      labels={labels}
                      unit="rate"
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
                  {labels.length > 0 ? (
                    <ServerAuditCharts
                      labels={labels}
                      unit="load"
                      series={[{ label: t('serverAudit.load'), color: '#475569', data: detail.points.map((point) => point.load_1) }]}
                    />
                  ) : (
                    <ChartEmpty>{t('serverAudit.chartNeed')}</ChartEmpty>
                  )}
                </ChartFrame>
              </div>

              <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold">{t('serverAudit.sensors')}</h3>
                  <input
                    value={sensorQuery}
                    onChange={(event) => setSensorQuery(event.target.value)}
                    placeholder={t('serverAudit.sensorPh')}
                    className="w-full rounded-full border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm sm:w-56"
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
                canEdit={canEdit}
                journalMode={detail.journal_mode || 'errors'}
                journalLines={detail.journal_lines || 20}
                retainDays={detail.retain_days || 14}
                onJournal={(patch) => void onJournal(patch)}
                keepLabel={t('serverAudit.journalKeep')}
                offLabel={t('serverAudit.journalOff')}
                linesLabel={t('serverAudit.journalLines')}
                retainLabel={t('serverAudit.retain')}
                daysLabel={(n) => t('serverAudit.retainDays', { n })}
              />

              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title={t('serverAudit.sensors')}>
                  <div className="border-b border-[var(--color-border)] px-3 py-2">
                    <input
                      value={sensorQuery}
                      onChange={(event) => setSensorQuery(event.target.value)}
                      placeholder={t('serverAudit.sensorPh')}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm"
                    />
                  </div>
                  {shownTemps.length === 0 ? (
                    <Empty>{t('serverAudit.noTemp')}</Empty>
                  ) : (
                    <SimpleTable
                      rows={shownTemps.map((row) => [
                        textOf(row.name),
                        fmtTemp(numOf(row.celsius)),
                        row.max != null || row.crit != null ? `${fmtTemp(numOf(row.max))} / ${fmtTemp(numOf(row.crit))}` : textOf(row.source),
                      ])}
                    />
                  )}
                  {fans.length > 0 ? (
                    <SimpleTable rows={fans.map((row) => [textOf(row.name), `${textOf(row.rpm)} rpm`])} />
                  ) : null}
                  {shownVolts.length > 0 ? (
                    <SimpleTable
                      head={[t('serverAudit.voltages'), 'V']}
                      rows={shownVolts.map((row) => [textOf(row.name), textOf(row.volts)])}
                    />
                  ) : null}
                </Panel>
                <Panel title={t('serverAudit.disks')}>
                  {disks.length === 0 ? (
                    <Empty>—</Empty>
                  ) : (
                    <div className="flex flex-col gap-3 p-3">
                      {disks.map((row, index) => {
                        const used = numOf(row.used_percent) ?? 0
                        return (
                          <div key={`${textOf(row.mount)}-${index}`}>
                            <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
                              <span className="truncate font-medium">{textOf(row.mount)}</span>
                              <span className="shrink-0 text-[var(--color-fg-subtle)]">
                                {fmtPct(numOf(row.used_percent))} · {textOf(row.free_gb)} {t('serverAudit.free')}
                              </span>
                            </div>
                            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                              <div className={`h-full rounded-full ${used >= 90 ? 'bg-rose-500' : used >= 75 ? 'bg-amber-500' : 'bg-sky-500'}`} style={{ width: `${Math.max(0, Math.min(100, used))}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </Panel>
                <Panel title={t('serverAudit.network')}>
                  <SimpleTable
                    rows={network.map((row) => [
                      textOf(row.name),
                      textOf(row.ipv4),
                      textOf(row.operstate),
                      `${fmtRate(numOf(row.rx_bps))} / ${fmtRate(numOf(row.tx_bps))}`,
                    ])}
                  />
                </Panel>
                <Panel title={t('serverAudit.processes')}>
                  <SimpleTable
                    head={['PID', t('serverAudit.user'), 'CPU', 'RAM', t('serverAudit.name')]}
                    rows={processes.map((row) => [
                      textOf(row.pid),
                      textOf(row.user),
                      fmtPct(numOf(row.cpu)),
                      textOf(row.rss_mb),
                      textOf(row.name),
                    ])}
                  />
                </Panel>
                <Panel title={t('serverAudit.listeners')}>
                  <SimpleTable rows={listeners.map((row) => [textOf(row.proto), textOf(row.address)])} />
                </Panel>
                <Panel title={t('serverAudit.failed')}>
                  {failed.length === 0 ? (
                    <Empty>{t('serverAudit.noFailed')}</Empty>
                  ) : (
                    <SimpleTable rows={failed.map((row) => [textOf(row.name), textOf(row.sub)])} />
                  )}
                </Panel>
              </div>

              <div className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm md:grid-cols-2">
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
                {sessions.length > 0 ? (
                  <Info label={t('serverAudit.sessions')} value={sessions.map((row) => textOf(row.user)).join(', ')} />
                ) : null}
                {docker.length > 0 ? (
                  <Info label={t('serverAudit.docker')} value={docker.map((row) => textOf(row.name)).join(', ')} />
                ) : null}
              </div>
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
    <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-3">
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
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
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

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <h3 className="border-b border-[var(--color-border)] px-3 py-2 text-sm font-semibold">{title}</h3>
      <div className="max-h-64 overflow-auto">{children}</div>
    </section>
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
  canEdit,
  journalMode,
  journalLines,
  retainDays,
  onJournal,
  keepLabel,
  offLabel,
  linesLabel,
  retainLabel,
  daysLabel,
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
  canEdit: boolean
  journalMode: 'off' | 'errors' | 'all'
  journalLines: number
  retainDays: number
  onJournal: (patch: { journal_mode?: 'off' | 'errors' | 'all'; journal_lines?: number; retain_days?: number }) => void
  keepLabel: string
  offLabel: string
  linesLabel: string
  retainLabel: string
  daysLabel: (n: number) => string
}) {
  const errors = logs.filter((row) => isLogError(String(row.level || '')))
  const shown = mode === 'err' ? errors : logs
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit ? (
            <>
              <label className="flex items-center gap-1 text-xs text-[var(--color-fg-subtle)]">
                {keepLabel}
                <select
                  value={journalMode}
                  onChange={(event) => onJournal({ journal_mode: event.target.value as 'off' | 'errors' | 'all' })}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
                >
                  <option value="off">{offLabel}</option>
                  <option value="errors">{errorsLabel}</option>
                  <option value="all">{allLabel}</option>
                </select>
              </label>
              <label className="flex items-center gap-1 text-xs text-[var(--color-fg-subtle)]">
                {linesLabel}
                <select
                  value={journalLines}
                  onChange={(event) => onJournal({ journal_lines: Number(event.target.value) })}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
                >
                  {[0, 10, 20, 40, 80].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-xs text-[var(--color-fg-subtle)]">
                {retainLabel}
                <select
                  value={retainDays}
                  onChange={(event) => onJournal({ retain_days: Number(event.target.value) })}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)]"
                >
                  {[7, 14, 30, 90].map((n) => (
                    <option key={n} value={n}>
                      {daysLabel(n)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {sourceLabel ? <span className="text-xs text-[var(--color-fg-subtle)]">{sourceLabel}</span> : null}
          <button
            type="button"
            onClick={() => onMode('err')}
            className={`rounded-md px-2 py-1 text-xs ${mode === 'err' ? 'bg-[var(--color-primary)] text-white' : 'border border-[var(--color-border)]'}`}
          >
            {errorsLabel} ({errors.length})
          </button>
          <button
            type="button"
            onClick={() => onMode('all')}
            className={`rounded-md px-2 py-1 text-xs ${mode === 'all' ? 'bg-[var(--color-primary)] text-white' : 'border border-[var(--color-border)]'}`}
          >
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
