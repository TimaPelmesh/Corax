import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type ServerAuditDetail, type ServerAuditHost } from '../api'
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
    }, 45000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [hours, loadDetail, loadHosts, selectedId, t, toast])

  const payload = detail?.payload ?? {}
  const os = asRecord(payload.os)
  const cpu = asRecord(payload.cpu)
  const memory = asRecord(payload.memory)
  const packages = asRecord(payload.packages)
  const pressure = asRecord(payload.pressure)
  const sockets = asRecord(payload.sockets)
  const timeInfo = asRecord(payload.time)
  const temps = asRows(payload.temperatures)
  const fans = asRows(payload.fans)
  const disks = asRows(payload.disks)
  const processes = asRows(payload.processes)
  const listeners = asRows(payload.listeners)
  const failed = asRows(payload.failed_units)
  const sessions = asRows(payload.sessions)
  const docker = asRows(payload.docker)
  const network = asRows(payload.network)

  const labels = useMemo(
    () => (detail?.points ?? []).map((point) => fmtWhen(point.collected_at, locale)),
    [detail?.points, locale],
  )

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
      <h1 className="sr-only">{t('titles.serverAudit')}</h1>
      <p className="max-w-3xl text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.subtitle')}</p>

      {canEdit ? (
        <form
          onSubmit={(event) => void onAdd(event)}
          className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 md:grid-cols-[1.2fr_1fr_180px_auto]"
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
            {t('serverAudit.hostname')}
            <input
              value={hostname}
              onChange={(event) => setHostname(event.target.value)}
              placeholder={t('serverAudit.hostnamePh')}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
              required
            />
          </label>
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
              disabled={busy}
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {t('serverAudit.add')}
            </button>
          </div>
          <p className="md:col-span-4 text-xs text-[var(--color-fg-subtle)]">{t('serverAudit.hint')}</p>
        </form>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
            <span className="text-sm font-medium">{t('common.total')}: {hosts.length}</span>
            <button
              type="button"
              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg-muted)]"
              onClick={() => void loadHosts().catch((error: unknown) => toast.error(error instanceof Error ? error.message : t('common.error')))}
            >
              {loading ? t('common.loading') : t('common.refresh')}
            </button>
          </div>
          {hosts.length === 0 ? (
            <p className="px-3 py-6 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.empty')}</p>
          ) : (
            <ul className="max-h-[70vh] divide-y divide-[var(--color-border)] overflow-auto">
              {hosts.map((host) => {
                const tone = freshness(host)
                const active = host.id === selectedId
                return (
                  <li key={host.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(host.id)}
                      className={`flex w-full flex-col gap-1 px-3 py-3 text-left ${active ? 'bg-[var(--color-bg-muted)]' : 'hover:bg-[var(--color-bg-muted)]'}`}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-semibold">{host.label || host.hostname}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${toneClass[tone]}`}>
                          {tone === 'fresh' ? t('serverAudit.fresh') : tone === 'stale' ? t('serverAudit.stale') : t('serverAudit.noData')}
                        </span>
                      </span>
                      <span className="truncate text-xs text-[var(--color-fg-subtle)]">
                        {host.hostname}
                        {host.ip_address ? ` · ${host.ip_address}` : ''}
                      </span>
                      <span className="text-xs text-[var(--color-fg-subtle)]">
                        {fmtTemp(host.latest_cpu_temp_c)} · CPU {fmtPct(host.latest_cpu_percent)} · RAM {fmtPct(host.latest_mem_percent)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
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
                      ? `${fmtWhen(detail.last_sample_at, locale)} · ${fmtUptime(detail.points.at(-1)?.uptime_sec)}`
                      : t('serverAudit.waitingAgent')}
                    {detail.collect_requested ? ` · ${t('serverAudit.queued')}` : ''}
                  </p>
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

              <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
                <Metric label={t('serverAudit.temp')} value={fmtTemp(detail.latest_cpu_temp_c)} />
                <Metric label={t('serverAudit.cpu')} value={fmtPct(detail.latest_cpu_percent)} />
                <Metric label={t('serverAudit.memory')} value={fmtPct(detail.latest_mem_percent)} />
                <Metric label={t('serverAudit.disk')} value={fmtPct(detail.latest_disk_percent)} />
                <Metric label={t('serverAudit.load')} value={detail.latest_load_1 == null ? '—' : detail.latest_load_1.toFixed(2)} />
                <Metric label={t('serverAudit.swap')} value={fmtPct(numOf(memory?.swap_used_percent))} />
              </div>

              <div className="flex flex-wrap gap-2">
                {([6, 24, 168] as Hours[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setHours(value)}
                    className={`rounded-lg px-3 py-1.5 text-sm ${hours === value ? 'bg-[var(--color-primary)] text-white' : 'border border-[var(--color-border)]'}`}
                  >
                    {value === 6 ? t('serverAudit.range6') : value === 24 ? t('serverAudit.range24') : t('serverAudit.range7')}
                  </button>
                ))}
              </div>

              {labels.length < 2 ? (
                <p className="text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.chartNeed')}</p>
              ) : (
                <div className="grid gap-4 xl:grid-cols-2">
                  <div className="h-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <ServerAuditCharts
                      labels={labels}
                      percent
                      series={[
                        { label: t('serverAudit.cpu'), color: '#2563eb', data: detail.points.map((p) => p.cpu_used_percent) },
                        { label: t('serverAudit.memory'), color: '#059669', data: detail.points.map((p) => p.mem_used_percent) },
                        { label: t('serverAudit.disk'), color: '#d97706', data: detail.points.map((p) => p.disk_used_percent) },
                        { label: t('serverAudit.temp'), color: '#e11d48', data: detail.points.map((p) => p.cpu_temp_c), axis: 'y1' },
                      ]}
                    />
                  </div>
                  <div className="h-64 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <ServerAuditCharts
                      labels={labels}
                      series={[
                        { label: t('serverAudit.rx'), color: '#0284c7', data: detail.points.map((p) => p.net_rx_bps) },
                        { label: t('serverAudit.tx'), color: '#7c3aed', data: detail.points.map((p) => p.net_tx_bps) },
                        { label: t('serverAudit.load'), color: '#64748b', data: detail.points.map((p) => p.load_1), axis: 'y1' },
                      ]}
                    />
                  </div>
                </div>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                <Panel title={t('serverAudit.temperatures')}>
                  {temps.length === 0 ? (
                    <Empty>{t('serverAudit.noTemp')}</Empty>
                  ) : (
                    <SimpleTable
                      rows={temps.map((row) => [textOf(row.name), fmtTemp(numOf(row.celsius)), textOf(row.source)])}
                    />
                  )}
                  {fans.length > 0 ? (
                    <SimpleTable rows={fans.map((row) => [textOf(row.name), `${textOf(row.rpm)} rpm`])} />
                  ) : null}
                </Panel>
                <Panel title={t('serverAudit.disks')}>
                  <SimpleTable
                    head={[t('serverAudit.mount'), t('serverAudit.used'), t('serverAudit.free'), t('serverAudit.inodes')]}
                    rows={disks.map((row) => [
                      textOf(row.mount),
                      fmtPct(numOf(row.used_percent)),
                      textOf(row.free_gb),
                      fmtPct(numOf(row.inodes_used_percent)),
                    ])}
                  />
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
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

function Info({ label, value, extra }: { label: string; value: string; extra?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{label}</div>
      <div className="font-medium">{value}</div>
      {extra ? <div className="truncate text-xs text-[var(--color-fg-subtle)]">{extra}</div> : null}
    </div>
  )
}
