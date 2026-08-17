import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  MarkerType,
  type DefaultEdgeOptions,
  type EdgeTypes,
  type Node,
  type NodeTypes,
} from 'reactflow'
import 'reactflow/dist/style.css'
import {
  api,
  type NetworkDevice,
  type NetworkJobStatus,
  type NetworkPollConfig,
  type NetworkTopology,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconClose } from '../components/icons'
import { NetworkDeviceDetailModal } from '../components/NetworkDeviceDetailModal'
import { NetworkMapNode } from '../components/network/NetworkMapNode'
import { useLocale } from '../i18n/LocaleContext'
import type { MessageKey } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { layoutTopology, mapNodeColor } from './networkMapLayout'

type ViewMode = 'list' | 'map'
type RoleFilter =
  | 'all'
  | 'gateway'
  | 'dns'
  | 'infra'
  | 'switch'
  | 'router'
  | 'ap'
  | 'firewall'
  | 'controller'
  | 'server'
  | 'nas'
  | 'voip'
  | 'ups'
  | 'camera'
  | 'modem'
  | 'host'
  | 'unknown'

/** Stable refs — React Flow warns if nodeTypes/edgeTypes are recreated each render. */
const RF_NODE_TYPES: NodeTypes = { topology: NetworkMapNode }
const RF_EDGE_TYPES: EdgeTypes = {}
const RF_DEFAULT_EDGE_OPTIONS: DefaultEdgeOptions = {
  type: 'smoothstep',
  markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
  style: { stroke: 'var(--color-fg-subtle)', strokeWidth: 1.25 },
}
const RF_PRO_OPTIONS = { hideAttribution: true }

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

function statusTone(status: string | null | undefined) {
  if (status === 'ok') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (status === 'error') return 'bg-red-500/15 text-red-700 dark:text-red-300'
  if (status === 'n/a') return 'bg-sky-500/15 text-sky-800 dark:text-sky-200'
  return 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
}

function roleTone(role: string) {
  switch (role) {
    case 'gateway':
      return 'bg-violet-600/20 text-violet-900 dark:text-violet-200'
    case 'dns':
      return 'bg-indigo-500/20 text-indigo-900 dark:text-indigo-200'
    case 'infra':
      return 'bg-[var(--color-surface-muted)]0/20 text-[var(--color-fg)] dark:text-slate-200'
    case 'switch':
      return 'bg-sky-500/15 text-sky-800 dark:text-sky-200'
    case 'router':
      return 'bg-violet-500/15 text-violet-800 dark:text-violet-200'
    case 'ap':
      return 'bg-teal-500/15 text-teal-800 dark:text-teal-200'
    case 'firewall':
      return 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
    case 'controller':
      return 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-200'
    case 'server':
      return 'bg-indigo-500/15 text-indigo-800 dark:text-indigo-200'
    case 'nas':
      return 'bg-blue-500/15 text-blue-800 dark:text-blue-200'
    case 'voip':
      return 'bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-200'
    case 'ups':
      return 'bg-yellow-500/15 text-yellow-800 dark:text-yellow-200'
    case 'camera':
      return 'bg-rose-500/15 text-rose-800 dark:text-rose-200'
    case 'modem':
      return 'bg-orange-500/15 text-orange-800 dark:text-orange-200'
    case 'host':
      return 'bg-blue-500/15 text-blue-900 dark:text-blue-200'
    default:
      return 'bg-[var(--color-surface-muted)]0/10 text-[var(--color-fg)] dark:text-slate-300'
  }
}

function roleLabelKey(role: string): MessageKey {
  if (role === 'gateway' || role === 'dns' || role === 'infra') {
    return `network.role.${role}` as MessageKey
  }
  return `network.type.${role}` as MessageKey
}

export function NetworkPage() {
  const { t, locale } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')

  const [view, setView] = useState<ViewMode>('list')
  const [rows, setRows] = useState<NetworkDevice[]>([])
  const [topo, setTopo] = useState<NetworkTopology | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [detailId, setDetailId] = useState<number | null>(null)
  const [job, setJob] = useState<NetworkJobStatus | null>(null)
  const [expandClusters, setExpandClusters] = useState<Set<string>>(() => new Set())
  const jobWasRunning = useRef(false)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [cfg, setCfg] = useState<NetworkPollConfig | null>(null)
  const [cfgBusy, setCfgBusy] = useState(false)
  const [cidrText, setCidrText] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [addIp, setAddIp] = useState('')
  const [addHostname, setAddHostname] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)

  const reload = useCallback(async () => {
    const [devices, topology] = await Promise.all([
      api.networkDevices({ q: search.trim() || undefined, limit: 1000 }),
      view === 'map' ? api.networkTopology() : Promise.resolve(null),
    ])
    setRows(devices)
    if (topology) setTopo(topology)
    return devices
  }, [search, view])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      try {
        await reload()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('network.loadFailed'))
      } finally {
        setLoading(false)
      }
    })()
  }, [reload, t, toast])

  const filtered = useMemo(() => {
    if (roleFilter === 'all') return rows
    return rows.filter((r) => (r.role || r.device_type) === roleFilter)
  }, [rows, roleFilter])

  const stats = useMemo(
    () => ({
      total: rows.length,
      ok: rows.filter((r) => r.snmp_status === 'ok').length,
      err: rows.filter((r) => r.snmp_status === 'error').length,
      links: topo?.edges.length ?? 0,
    }),
    [rows, topo],
  )

  const flow = useMemo(
    () => (topo ? layoutTopology(topo, expandClusters) : { nodes: [], edges: [] }),
    [topo, expandClusters],
  )

  const jobBusy = Boolean(job?.running)
  const pollBusy = jobBusy && job?.kind === 'poll'
  const discoverBusy = jobBusy && job?.kind === 'discover' // legacy jobs still in progress

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const st = await api.networkJobStatus()
        if (cancelled) return
        const was = jobWasRunning.current
        setJob(st)
        if (st.running) {
          jobWasRunning.current = true
        } else if (was) {
          jobWasRunning.current = false
          await reload()
          const msg = (st.last_result?.message as string) || st.message || t('network.pollDone')
          toast.info(msg)
        }
      } catch {
        /* ignore status blips */
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [reload, t, toast])

  const onMapNodeClick = useCallback((_: unknown, node: Node) => {
    const clusterOf = (node.data as { clusterOf?: string })?.clusterOf
    if (clusterOf) {
      setExpandClusters((prev) => {
        const next = new Set(prev)
        next.add(clusterOf)
        return next
      })
      return
    }
    if (node.id.startsWith('network_device:')) {
      const id = Number(node.id.split(':')[1])
      if (Number.isFinite(id)) setDetailId(id)
    }
  }, [])

  const openCfg = async () => {
    try {
      const c = await api.networkPollConfig()
      setCfg(c)
      setCidrText((c.cidr_list || []).join(', '))
      setCfgOpen(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.loadFailed'))
    }
  }

  const saveCfg = async () => {
    if (!canEdit || !cfg) return
    setCfgBusy(true)
    try {
      const cidr_list = cidrText
        .split(/[,;\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const saved = await api.updateNetworkPollConfig({
        poll_enabled: cfg.poll_enabled,
        poll_interval_minutes: cfg.poll_interval_minutes,
        snmp_community: cfg.snmp_community,
        snmp_timeout_seconds: cfg.snmp_timeout_seconds,
        poll_concurrency: cfg.poll_concurrency,
        cidr_list,
      })
      setCfg(saved)
      toast.ok(t('network.settingsSaved'))
      setCfgOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.saveFailed'))
    } finally {
      setCfgBusy(false)
    }
  }

  const runPoll = async () => {
    if (!canEdit || jobBusy) return
    try {
      const st = await api.pollAllNetworkDevices()
      setJob(st)
      jobWasRunning.current = true
      toast.info(t('network.jobStartedLeave'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.pollFailed'))
    }
  }

  const submitAdd = async () => {
    if (!canEdit || !addIp.trim()) return
    setAddBusy(true)
    try {
      await api.createNetworkDevice({
        ip_address: addIp.trim(),
        hostname: addHostname.trim() || null,
      })
      setAddOpen(false)
      setAddIp('')
      setAddHostname('')
      await reload()
      toast.info(t('network.addedHint'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.addFailed'))
    } finally {
      setAddBusy(false)
    }
  }

  const deleteSelected = async () => {
    if (!canEdit || selected.size === 0) return
    setDeleteBusy(true)
    try {
      const ids = [...selected]
      if (ids.length === 1) await api.deleteNetworkDevice(ids[0])
      else await api.bulkDeleteNetworkDevices(ids)
      setSelected(new Set())
      await reload()
      toast.ok(t('network.deletedN', { n: ids.length }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.deleteFailed'))
    } finally {
      setDeleteBusy(false)
    }
  }

  const roleFilters: RoleFilter[] = [
    'all',
    'gateway',
    'dns',
    'infra',
    'switch',
    'router',
    'ap',
    'firewall',
    'controller',
    'server',
    'host',
    'nas',
    'voip',
    'ups',
    'camera',
    'modem',
    'unknown',
  ]

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5">
            <button
              type="button"
              onClick={() => setView('list')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === 'list' ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-fg-subtle)]'}`}
            >
              {t('network.viewList')}
            </button>
            <button
              type="button"
              onClick={() => setView('map')}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === 'map' ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-fg-subtle)]'}`}
            >
              {t('network.viewMap')}
            </button>
          </div>
          {canEdit ? (
            <>
              <button
                type="button"
                onClick={() => void openCfg()}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
              >
                {t('network.snmpSettings')}
              </button>
              <button
                type="button"
                disabled={pollBusy || discoverBusy}
                onClick={() => void runPoll()}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {pollBusy ? t('network.pollBusy') : t('network.pollAll')}
              </button>
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
              >
                {t('network.addManual')}
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {t('network.statTotal')}: <strong>{stats.total}</strong>
        </span>
        <span className="rounded-lg bg-emerald-500/10 px-3 py-1.5 text-emerald-800 dark:text-emerald-200">
          SNMP OK: <strong>{stats.ok}</strong>
        </span>
        <span className="rounded-lg bg-red-500/10 px-3 py-1.5 text-red-800 dark:text-red-200">
          {t('network.statErrors')}: <strong>{stats.err}</strong>
        </span>
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {t('network.statLinks')}: <strong>{stats.links}</strong>
        </span>
      </div>

      {jobBusy && job ? (
        <div className="relative overflow-hidden rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-surface)] px-4 py-3 shadow-sm">
          <div className="flex items-start gap-3">
            <span
              className="mt-0.5 inline-block h-8 w-8 shrink-0 animate-spin rounded-full border-[3px] border-[var(--color-primary)]/25 border-t-[var(--color-primary)]"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-[var(--color-fg)]">
                  {job.kind === 'discover' ? t('network.jobDiscoverTitle') : t('network.jobPollTitle')}
                </p>
                <span className="text-xs font-medium text-[var(--color-fg-subtle)]">{job.progress}%</span>
              </div>
              <p className="mt-0.5 text-sm text-[var(--color-fg-subtle)]">{job.message || t('network.jobWorking')}</p>
              <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">{t('network.jobCanLeave')}</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                <div
                  className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-500 ease-out"
                  style={{ width: `${Math.max(4, job.progress)}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {view === 'list' ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('common.search')}
              className="min-w-[12rem] flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm sm:max-w-xs"
            />
            <div className="flex flex-wrap gap-1">
              {roleFilters.map((f) => {
                const labelKey = (f === 'all' ? 'network.filterAll' : roleLabelKey(f)) as MessageKey
                return (
                  <button
                    key={f}
                    type="button"
                    onClick={() => setRoleFilter(f)}
                    className={`rounded-full px-3 py-1 text-xs font-medium ${
                      roleFilter === f
                        ? 'bg-[var(--color-primary)] text-white'
                        : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-subtle)]'
                    }`}
                  >
                    {t(labelKey)}
                  </button>
                )
              })}
            </div>
            {canEdit && selected.size > 0 ? (
              <button
                type="button"
                disabled={deleteBusy}
                onClick={() => void deleteSelected()}
                className="rounded-lg border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {t('network.deleteN', { n: selected.size })}
              </button>
            ) : null}
          </div>

          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                <tr>
                  {canEdit ? <th className="w-10 px-3 py-2.5" /> : null}
                  <th className="app-table-sticky-col px-3 py-2.5">{t('network.colHostname')}</th>
                  <th className="px-3 py-2.5">{t('network.colIp')}</th>
                  <th className="px-3 py-2.5">{t('network.colRole')}</th>
                  <th className="app-hide-xs px-3 py-2.5">{t('network.colVendor')}</th>
                  <th className="px-3 py-2.5">{t('network.colStatus')}</th>
                  <th className="app-hide-xs px-3 py-2.5">{t('network.colLastPoll')}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-fg-subtle)]">
                      {t('common.loading')}
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-[var(--color-fg-subtle)]">
                      {t('network.empty')}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer border-b border-[var(--color-border)]/70 hover:bg-[var(--color-bg-muted)]/50"
                      onClick={() => setDetailId(r.id)}
                    >
                      {canEdit ? (
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            onChange={() => {
                              setSelected((prev) => {
                                const next = new Set(prev)
                                if (next.has(r.id)) next.delete(r.id)
                                else next.add(r.id)
                                return next
                              })
                            }}
                            aria-label={t('network.selectOne', { name: r.hostname || r.ip_address })}
                          />
                        </td>
                      ) : null}
                      <td className="app-table-sticky-col px-3 py-2 font-medium">{r.hostname || r.sys_name || '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.ip_address}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${roleTone(r.role || r.device_type)}`}
                        >
                          {t(roleLabelKey(r.role || r.device_type))}
                        </span>
                      </td>
                      <td className="app-hide-xs px-3 py-2">{r.vendor || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusTone(r.snmp_status)}`}>
                          {r.snmp_status || '—'}
                        </span>
                      </td>
                      <td className="app-hide-xs px-3 py-2 text-[var(--color-fg-subtle)]">{fmtWhen(r.last_snmp_at, locale)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
            <span className="inline-flex items-center gap-1.5 text-[var(--color-fg)]">
              <span className="h-[2px] w-5 rounded-full bg-[#7c3aed]" />
              {t('network.mapLegendTrace')}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[var(--color-fg)]">
              <span className="h-[2px] w-5 rounded-full bg-[var(--color-primary)]" />
              {t('network.mapLegendLldp')}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[var(--color-fg-muted)]">
              <span className="h-[2px] w-5 rounded-full bg-[var(--color-fg-subtle)]" />
              {t('network.mapLegendHosts')}
            </span>
            <span className="text-[var(--color-fg-subtle)]">{t('network.mapHint')}</span>
            {expandClusters.size > 0 ? (
              <button
                type="button"
                onClick={() => setExpandClusters(new Set())}
                className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-medium hover:bg-[var(--color-bg-muted)]"
              >
                {t('network.mapCollapsePcs')}
              </button>
            ) : null}
          </div>
          <div className="h-[min(82vh,920px)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
            {flow.nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-[var(--color-fg-subtle)]">
                {t('network.mapEmpty')}
              </div>
            ) : (
              <ReactFlow
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={RF_NODE_TYPES}
                edgeTypes={RF_EDGE_TYPES}
                defaultEdgeOptions={RF_DEFAULT_EDGE_OPTIONS}
                fitView
                fitViewOptions={{ padding: 0.16, minZoom: 0.18, maxZoom: 1.6 }}
                minZoom={0.12}
                maxZoom={1.8}
                onNodeClick={onMapNodeClick}
                proOptions={RF_PRO_OPTIONS}
              >
                <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="var(--color-border)" />
                <Controls />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) =>
                    mapNodeColor((node.data as { deviceType?: string } | undefined)?.deviceType)
                  }
                />
              </ReactFlow>
            )}
          </div>
        </div>
      )}

      {detailId != null ? (
        <NetworkDeviceDetailModal
          deviceId={detailId}
          onClose={() => setDetailId(null)}
          onChanged={() => void reload()}
        />
      ) : null}

      {cfgOpen && cfg
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl">
                <div className="mb-4 flex items-start justify-between">
                  <div>
                    <h2 className="text-lg font-semibold">{t('network.snmpCfgTitle')}</h2>
                    <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.snmpCfgSub')}</p>
                  </div>
                  <button type="button" onClick={() => setCfgOpen(false)} aria-label={t('common.close')}>
                    <IconClose className="h-6 w-6" />
                  </button>
                </div>
                <div className="space-y-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={cfg.poll_enabled}
                      onChange={(e) => setCfg({ ...cfg, poll_enabled: e.target.checked })}
                    />
                    {t('network.pollEnabled')}
                  </label>
                  <label className="block">
                    {t('network.community')}
                    <input
                      className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
                      value={cfg.snmp_community}
                      onChange={(e) => setCfg({ ...cfg, snmp_community: e.target.value })}
                    />
                  </label>
                  <label className="block">
                    {t('network.cidrList')}
                    <textarea
                      className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono text-xs"
                      rows={3}
                      placeholder="192.168.1.0/24, 10.0.0.0/24"
                      value={cidrText}
                      onChange={(e) => setCidrText(e.target.value)}
                    />
                    <span className="mt-1 block text-xs text-[var(--color-fg-subtle)]">{t('network.cidrHint')}</span>
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      {t('network.timeoutSec')}
                      <input
                        type="number"
                        className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
                        value={cfg.snmp_timeout_seconds}
                        onChange={(e) => setCfg({ ...cfg, snmp_timeout_seconds: Number(e.target.value) })}
                      />
                    </label>
                    <label className="block">
                      {t('network.concurrency')}
                      <input
                        type="number"
                        className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
                        value={cfg.poll_concurrency}
                        onChange={(e) => setCfg({ ...cfg, poll_concurrency: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCfgOpen(false)}
                    className="rounded-lg border border-[var(--color-border)] px-3 py-2"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={cfgBusy || !canEdit}
                    onClick={() => void saveCfg()}
                    className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-white disabled:opacity-50"
                  >
                    {t('common.save')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

      {addOpen
        ? createPortal(
            <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4">
              <div className="w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-xl">
                <h2 className="mb-3 text-lg font-semibold">{t('network.addTitle')}</h2>
                <label className="mb-3 block text-sm">
                  {t('network.addIp')}
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2 font-mono"
                    value={addIp}
                    onChange={(e) => setAddIp(e.target.value)}
                  />
                </label>
                <label className="mb-4 block text-sm">
                  {t('network.addHostname')}
                  <input
                    className="mt-1 w-full rounded-lg border border-[var(--color-border)] px-3 py-2"
                    value={addHostname}
                    onChange={(e) => setAddHostname(e.target.value)}
                  />
                </label>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setAddOpen(false)} className="rounded-lg border px-3 py-2 text-sm">
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    disabled={addBusy || !addIp.trim()}
                    onClick={() => void submitAdd()}
                    className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm text-white disabled:opacity-50"
                  >
                    {t('common.add')}
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}

    </div>
  )
}
