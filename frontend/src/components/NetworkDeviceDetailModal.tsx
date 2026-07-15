import { useEffect, useState } from 'react'
import { api, type NetworkDevice } from '../api'
import { useAuth } from '../AuthContext'
import { IconClose } from './icons'
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
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('network.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6" role="dialog">
      <button type="button" className="absolute inset-0 cursor-default" aria-label={t('common.close')} onClick={onClose} />
      <div className="relative z-10 flex max-h-[min(92dvh,52rem)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl sm:rounded-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-[var(--color-fg)]">
              {row?.hostname || row?.ip_address || t('network.device')}
            </h2>
            <p className="mt-0.5 font-mono text-sm text-[var(--color-fg-subtle)]">{row?.ip_address}</p>
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!row ? (
            <p className="text-sm text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
          ) : (
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

              {row.sys_descr ? (
                <div>
                  <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
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
                      {[
                        'switch',
                        'router',
                        'ap',
                        'firewall',
                        'controller',
                        'server',
                        'nas',
                        'voip',
                        'ups',
                        'camera',
                        'modem',
                        'unknown',
                      ].map((k) => (
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

              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('network.interfaces')} ({row.interfaces?.length ?? 0})
                </h3>
                {(row.interfaces?.length ?? 0) === 0 ? (
                  <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noInterfaces')}</p>
                ) : (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {row.interfaces.slice(0, 80).map((iface) => (
                      <li
                        key={iface.if_index}
                        className="flex flex-wrap gap-x-3 rounded border border-[var(--color-border)] px-2 py-1.5"
                      >
                        <span className="font-mono">{iface.name || iface.descr || `#${iface.if_index}`}</span>
                        <span className="text-[var(--color-fg-subtle)]">{iface.oper_status || '—'}</span>
                        {iface.mac ? <span className="font-mono text-[var(--color-fg-subtle)]">{iface.mac}</span> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('network.neighbors')} ({row.neighbors?.length ?? 0})
                </h3>
                {(row.neighbors?.length ?? 0) === 0 ? (
                  <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noNeighbors')}</p>
                ) : (
                  <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
                    {row.neighbors.map((n, i) => (
                      <li key={`${n.protocol}-${i}`} className="rounded border border-[var(--color-border)] px-2 py-1.5">
                        <span className="uppercase text-[var(--color-fg-subtle)]">{n.protocol}</span>{' '}
                        <span className="font-medium">{n.remote_name || n.remote_ip || '—'}</span>
                        {n.local_port ? (
                          <span className="text-[var(--color-fg-subtle)]">
                            {' '}
                            · {n.local_port}
                            {n.remote_port ? ` ↔ ${n.remote_port}` : ''}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">
                  {t('network.fdb')} ({row.fdb?.length ?? 0})
                </h3>
                {(row.fdb?.length ?? 0) === 0 ? (
                  <p className="text-sm text-[var(--color-fg-subtle)]">{t('network.noFdb')}</p>
                ) : (
                  <ul className="max-h-32 space-y-1 overflow-y-auto font-mono text-xs">
                    {row.fdb.slice(0, 100).map((e) => (
                      <li key={`${e.mac}-${e.port}`}>
                        {e.mac}
                        {e.port || e.if_index ? ` · port ${e.if_index || e.port}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
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
    </div>
  )
}
