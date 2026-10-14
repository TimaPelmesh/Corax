import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type NetworkDevice, type NetworkDeviceInterface } from '../api'
import { useAuth } from '../AuthContext'
import { IconClose } from './icons'
import { NetworkTypeIcon, NETWORK_DEVICE_TYPE_OPTIONS } from './NetworkTypeIcon'
import { useLocale } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

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

type TraceRouteExtra = {
  target_ip?: string
  measured_at?: string
  hops?: Array<{ ip?: string; rtt_ms?: number | null }>
}

function getTraceRoute(extras: Record<string, unknown> | null | undefined): TraceRouteExtra | null {
  const value = extras?.trace_route
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const route = value as TraceRouteExtra
  return Array.isArray(route.hops) && route.hops.length > 0 ? route : null
}

type CardTab = 'overview' | 'interfaces' | 'mac' | 'neighbors' | 'vlans'

const IF_TYPE_LABEL: Record<number, string> = {
  6: 'Ethernet',
  24: 'loopback',
  53: 'virtual',
  62: 'FastEthernet',
  69: 'FastEthernet',
  71: 'Wi‑Fi',
  117: 'Gigabit',
  131: 'tunnel',
  135: 'VLAN',
  136: 'L3 VLAN',
  161: 'LAG',
  169: 'Wi‑Fi',
  188: 'radio',
}

function fmtSpeed(bps: number | null | undefined) {
  if (bps == null || bps <= 0) return '—'
  if (bps >= 1_000_000_000) {
    const g = bps / 1_000_000_000
    return `${Number.isInteger(g) ? g.toFixed(0) : g.toFixed(1)} G`
  }
  if (bps >= 1_000_000) return `${Math.round(bps / 1_000_000)} M`
  return String(bps)
}

function portName(iface: NetworkDeviceInterface | undefined, ifIndex: string | null | undefined) {
  if (iface) return iface.name || iface.descr || `#${iface.if_index}`
  return ifIndex ? `#${ifIndex}` : '—'
}

type Props = {
  deviceId: number
  onClose: () => void
  onChanged: () => void
}

export function NetworkDeviceDetailModal({ deviceId, onClose, onChanged }: Props) {
  const { t, locale } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const canEdit = Boolean(user?.is_superuser || user?.role === 'editor')
  const [row, setRow] = useState<NetworkDevice | null>(null)
  const [busy, setBusy] = useState(false)
  const [hostname, setHostname] = useState('')
  const [deviceType, setDeviceType] = useState('unknown')
  const [location, setLocation] = useState('')
  const [notes, setNotes] = useState('')
  const [tab, setTab] = useState<CardTab>('overview')
  const [query, setQuery] = useState('')
  const traceRoute = getTraceRoute(row?.extras)
  const vlans = Array.isArray(row?.extras?.vlans) ? (row.extras.vlans as Array<{ id?: number; name?: string }>) : []

  const load = async () => {
    try {
      const d = await api.networkDevice(deviceId)
      setRow(d)
      setHostname(d.hostname || '')
      setDeviceType(d.device_type || 'unknown')
      setLocation(d.location || '')
      setNotes(d.notes || '')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.loadFailed'))
    }
  }

  useEffect(() => {
    setTab('overview')
    setQuery('')
    void load()
  }, [deviceId])

  const poll = async () => {
    if (!canEdit) return
    setBusy(true)
    try {
      const d = await api.pollNetworkDevice(deviceId)
      setRow(d)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.pollFailed'))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!canEdit) return
    setBusy(true)
    try {
      const d = await api.patchNetworkDevice(deviceId, {
        hostname: hostname.trim() || null,
        device_type: deviceType,
        location: location.trim() || null,
        notes: notes.trim() || null,
      })
      setRow(d)
      setDeviceType(d.device_type || deviceType)
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const ifaces = row?.interfaces ?? []
  const fdbRows = row?.fdb ?? []
  const neighborRows = row?.neighbors ?? []
  const ifByIndex = new Map(ifaces.map((iface) => [String(iface.if_index), iface]))
  const match = (...parts: Array<string | number | null | undefined>) =>
    !needle || parts.filter((part) => part != null && part !== '').join(' ').toLowerCase().includes(needle)
  const shownIfaces = ifaces.filter((iface) =>
    match(iface.name, iface.descr, iface.alias, iface.mac, iface.oper_status, iface.admin_status, iface.if_index),
  )
  const shownFdb = fdbRows.filter((entry) => {
    const iface = ifByIndex.get(String(entry.if_index || ''))
    return match(entry.mac, entry.port, entry.if_index, entry.vlan, iface?.name, iface?.alias)
  })
  const shownNeighbors = neighborRows.filter((item) =>
    match(item.protocol, item.remote_name, item.remote_ip, item.remote_port, item.local_port, item.remote_descr, item.remote_chassis),
  )
  const shownVlans = vlans.filter((vlan) => match(vlan.id, vlan.name))
  const tabCounts: Record<CardTab, number | null> = {
    overview: null,
    interfaces: ifaces.length,
    mac: fdbRows.length,
    neighbors: neighborRows.length,
    vlans: vlans.length,
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-stretch justify-center bg-slate-900/40 p-0 sm:items-center sm:p-3"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="pc-card-shell app-card relative z-10 flex w-full max-w-none flex-col overflow-hidden rounded-none border-0 p-3 shadow-none sm:rounded-xl sm:border sm:border-[var(--color-border)] sm:p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)]">
              <NetworkTypeIcon type={row?.device_type || deviceType} className="h-6 w-6" />
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-[var(--color-fg)]">
                {row?.hostname || row?.ip_address || t('network.device')}
              </h2>
              <p className="mt-0.5 font-mono text-sm text-[var(--color-fg-subtle)]">{row?.ip_address}</p>
              {row ? (
                <p className="mt-1 text-xs font-medium text-[var(--color-fg-muted)]">
                  {t(`network.type.${row.device_type}` as 'network.type.switch')}
                </p>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-muted)]"
            aria-label={t('common.close')}
          >
            <IconClose className="h-6 w-6" />
          </button>
        </header>

        {row ? (
          <div
            role="tablist"
            aria-label={t('network.tabsLabel')}
            className="mt-3 flex shrink-0 gap-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/80 p-1"
          >
            {(
              [
                ['overview', t('network.tabOverview')],
                ['interfaces', t('network.interfaces')],
                ['mac', t('network.fdb')],
                ['neighbors', t('network.neighbors')],
                ['vlans', t('network.tabVlans')],
              ] as const
            ).map(([id, label]) => {
              const active = tab === id
              const count = tabCounts[id]
              return (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={`flex min-h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm font-medium transition ${
                    active
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm ring-1 ring-[var(--color-border)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)]/60 hover:text-[var(--color-fg)]'
                  }`}
                  onClick={() => {
                    setTab(id)
                    setQuery('')
                  }}
                >
                  <span className="truncate">{label}</span>
                  {count != null ? (
                    <span
                      className={`rounded-full px-1.5 text-xs font-medium tabular-nums ${
                        active
                          ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
                          : 'bg-[var(--color-surface)] text-[var(--color-fg-subtle)]'
                      }`}
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
        ) : null}

        {row && tab !== 'overview' ? (
          <input
            className="mt-3 w-full shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
            value={query}
            placeholder={
              tab === 'interfaces'
                ? t('network.searchInterfaces')
                : tab === 'mac'
                  ? t('network.searchMac')
                  : tab === 'neighbors'
                    ? t('network.searchNeighbors')
                    : t('network.colVlan')
            }
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}

        <div className="app-scroll mt-2 min-h-0 flex-1 overflow-y-auto px-1 py-2">
          {!row ? (
            <p className="text-sm text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
          ) : tab === 'overview' ? (
            <div className="space-y-5">
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-[var(--color-fg-subtle)]">{t('network.colRole')}</dt>
                  <dd className="font-medium">
                    {row.role === 'gateway' || row.role === 'dns' || row.role === 'infra'
                      ? t(`network.role.${row.role}` as 'network.role.gateway')
                      : t(`network.type.${row.role || row.device_type}` as 'network.type.switch')}
                  </dd>
                </div>
                <div>
                  <dt className="text-[var(--color-fg-subtle)]">{t('network.colType')}</dt>
                  <dd className="font-medium">{t(`network.type.${row.device_type}` as 'network.type.switch')}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-fg-subtle)]">{t('network.colVendor')}</dt>
                  <dd className="font-medium">{row.vendor || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-fg-subtle)]">{t('network.colStatus')}</dt>
                  <dd className="font-medium">{row.snmp_status || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[var(--color-fg-subtle)]">{t('network.colLastPoll')}</dt>
                  <dd className="font-medium">{fmtWhen(row.last_snmp_at, locale)}</dd>
                </div>
              </dl>

              {row.extras && Object.keys(row.extras).length > 0 ? (
                <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
                  {row.extras.model ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasModel')}</dt>
                      <dd className="font-medium">{String(row.extras.model)}</dd>
                    </div>
                  ) : null}
                  {row.extras.serial_number ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasSerial')}</dt>
                      <dd className="font-mono text-xs font-medium">{String(row.extras.serial_number)}</dd>
                    </div>
                  ) : null}
                  {row.extras.classify_confidence != null ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasConfidence')}</dt>
                      <dd className="font-medium">
                        {Math.round(Number(row.extras.classify_confidence) * 100)}%
                      </dd>
                    </div>
                  ) : null}
                  {row.extras.sys_uptime_human ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasUptime')}</dt>
                      <dd className="font-medium">{String(row.extras.sys_uptime_human)}</dd>
                    </div>
                  ) : null}
                  {row.extras.interfaces_total != null ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasIfaces')}</dt>
                      <dd className="font-medium">
                        {String(row.extras.interfaces_up ?? 0)}/{String(row.extras.interfaces_total)} up
                      </dd>
                    </div>
                  ) : null}
                  {row.extras.ethernet_ports != null ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasEthPorts')}</dt>
                      <dd className="font-medium">{String(row.extras.ethernet_ports)}</dd>
                    </div>
                  ) : null}
                  {row.extras.wifi_ports != null && Number(row.extras.wifi_ports) > 0 ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasWifiPorts')}</dt>
                      <dd className="font-medium">{String(row.extras.wifi_ports)}</dd>
                    </div>
                  ) : null}
                  {row.extras.bridge_num_ports != null ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasBridgePorts')}</dt>
                      <dd className="font-medium">{String(row.extras.bridge_num_ports)}</dd>
                    </div>
                  ) : null}
                  {row.extras.ip_forwarding != null ? (
                    <div>
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasForwarding')}</dt>
                      <dd className="font-medium">
                        {row.extras.ip_forwarding ? t('network.yes') : t('network.no')}
                      </dd>
                    </div>
                  ) : null}
                  {Array.isArray(row.extras.ip_addresses) && row.extras.ip_addresses.length > 0 ? (
                    <div className="sm:col-span-3">
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasIps')}</dt>
                      <dd className="font-mono text-xs">{(row.extras.ip_addresses as string[]).join(', ')}</dd>
                    </div>
                  ) : null}
                  {Array.isArray(row.extras.classify_signals) && row.extras.classify_signals.length > 0 ? (
                    <div className="sm:col-span-3">
                      <dt className="text-[var(--color-fg-subtle)]">{t('network.extrasSignals')}</dt>
                      <dd className="mt-1 flex flex-wrap gap-1.5">
                        {(row.extras.classify_signals as string[]).map((s) => (
                          <span
                            key={s}
                            className="rounded bg-[var(--color-bg-muted)] px-2 py-0.5 font-mono text-[11px] text-[var(--color-fg-subtle)]"
                          >
                            {s}
                          </span>
                        ))}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}

              {traceRoute ? (
                <section>
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
                      {t('network.traceRoute')}
                    </h3>
                    <span className="text-[11px] text-[var(--color-fg-subtle)]">
                      {fmtWhen(traceRoute.measured_at, locale)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)] p-3">
                    {traceRoute.hops?.map((hop, index) => (
                      <div key={`${hop.ip}-${index}`} className="flex items-center gap-1.5">
                        {index > 0 ? <span className="text-[var(--color-fg-subtle)]">→</span> : null}
                        <span className="rounded-lg bg-[var(--color-surface)] px-2.5 py-1.5 font-mono text-xs text-[var(--color-fg)] shadow-sm">
                          {hop.ip || '—'}
                          {hop.rtt_ms != null ? (
                            <span className="ml-1 text-[10px] text-[var(--color-fg-subtle)]">
                              {hop.rtt_ms} ms
                            </span>
                          ) : null}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}

              {row.sys_descr ? (
                <div>
                  <h3 className="mb-1 text-[13px] font-semibold text-[var(--color-fg-subtle)]">
                    sysDescr
                  </h3>
                  <pre className="whitespace-pre-wrap rounded-lg bg-[var(--color-bg-muted)] p-3 text-xs text-[var(--color-fg)]">
                    {row.sys_descr}
                  </pre>
                </div>
              ) : null}

              {canEdit ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="text-[var(--color-fg-subtle)]">{t('network.colHostname')}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                      value={hostname}
                      onChange={(e) => setHostname(e.target.value)}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-[var(--color-fg-subtle)]">{t('network.colType')}</span>
                    <select
                      className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                      value={deviceType}
                      onChange={(e) => setDeviceType(e.target.value)}
                    >
                      {[...NETWORK_DEVICE_TYPE_OPTIONS].map((k) => (
                        <option key={k} value={k}>
                          {t(`network.type.${k}` as 'network.type.switch')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-[var(--color-fg-subtle)]">{t('network.colLocation')}</span>
                    <input
                      className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                    />
                  </label>
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-[var(--color-fg-subtle)]">{t('network.notes')}</span>
                    <textarea
                      className="mt-1 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2"
                      rows={2}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                    />
                  </label>
                </div>
              ) : null}

            </div>
          ) : tab === 'interfaces' ? (
            shownIfaces.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noInterfaces')}</p>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-left text-xs">
                <thead className="sticky top-0 bg-[var(--color-surface)]">
                  <tr className="text-[var(--color-fg-subtle)]">
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colPort')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colAlias')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colOper')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colAdmin')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colSpeed')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colMac')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownIfaces.map((iface) => (
                    <tr key={iface.if_index} className="align-top">
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5 font-mono">
                        {portName(iface, iface.if_index)}
                        <div className="text-[10px] text-[var(--color-fg-subtle)]">
                          {iface.if_type != null ? IF_TYPE_LABEL[iface.if_type] || `#${iface.if_type}` : ''}
                        </div>
                      </td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5">{iface.alias || iface.descr || '—'}</td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5">{iface.oper_status || '—'}</td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5">{iface.admin_status || '—'}</td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5 tabular-nums">{fmtSpeed(iface.speed)}</td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5 font-mono">{iface.mac || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : tab === 'mac' ? (
            shownFdb.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noFdb')}</p>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-left text-xs">
                <thead className="sticky top-0 bg-[var(--color-surface)]">
                  <tr className="text-[var(--color-fg-subtle)]">
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colMac')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colVlan')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colPort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownFdb.map((entry, index) => {
                    const iface = ifByIndex.get(String(entry.if_index || ''))
                    return (
                      <tr key={`${entry.mac}-${entry.vlan ?? ''}-${entry.if_index ?? ''}-${index}`}>
                        <td className="border-b border-[var(--color-border)] px-2 py-1.5 font-mono">{entry.mac}</td>
                        <td className="border-b border-[var(--color-border)] px-2 py-1.5 tabular-nums">{entry.vlan ?? '—'}</td>
                        <td className="border-b border-[var(--color-border)] px-2 py-1.5 font-mono">
                          {portName(iface, entry.if_index)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          ) : tab === 'neighbors' ? (
            shownNeighbors.length === 0 ? (
              <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noNeighbors')}</p>
            ) : (
              <table className="w-full border-separate border-spacing-0 text-left text-xs">
                <thead className="sticky top-0 bg-[var(--color-surface)]">
                  <tr className="text-[var(--color-fg-subtle)]">
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colProtocol')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colLocal')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colRemote')}</th>
                    <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colRemotePort')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownNeighbors.map((item, index) => (
                    <tr key={`${item.protocol}-${item.remote_ip}-${index}`} className="align-top">
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5 uppercase">{item.protocol}</td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5 font-mono">{item.local_port || '—'}</td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5">
                        <div className="font-medium">{item.remote_name || '—'}</div>
                        <div className="font-mono text-[10px] text-[var(--color-fg-subtle)]">
                          {item.remote_ip || item.remote_chassis || ''}
                        </div>
                      </td>
                      <td className="border-b border-[var(--color-border)] px-2 py-1.5 font-mono">{item.remote_port || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : shownVlans.length === 0 ? (
            <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noVlans')}</p>
          ) : (
            <table className="w-full border-separate border-spacing-0 text-left text-xs">
              <thead className="sticky top-0 bg-[var(--color-surface)]">
                <tr className="text-[var(--color-fg-subtle)]">
                  <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colVlan')}</th>
                  <th className="border-b border-[var(--color-border)] px-2 py-2 font-medium">{t('network.colHostname')}</th>
                </tr>
              </thead>
              <tbody>
                {shownVlans.map((vlan) => (
                  <tr key={vlan.id ?? vlan.name}>
                    <td className="border-b border-[var(--color-border)] px-2 py-1.5 tabular-nums">{vlan.id ?? '—'}</td>
                    <td className="border-b border-[var(--color-border)] px-2 py-1.5">{vlan.name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--color-border)] px-5 py-3">
          {canEdit ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void poll()}
                className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
              >
                {busy ? t('network.pollBusy') : t('network.pollOne')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('common.save')}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
          >
            {t('common.close')}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}
