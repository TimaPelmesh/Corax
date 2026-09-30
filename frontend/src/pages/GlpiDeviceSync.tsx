import { useMemo, useState } from 'react'
import { api, type GlpiDeviceKind, type GlpiDeviceRow, type GlpiTicketSyncResult } from '../api'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function formatUtc(value: string | null): string {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${parsed.getUTCFullYear()}-${pad(parsed.getUTCMonth() + 1)}-${pad(parsed.getUTCDate())} ${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}:${pad(parsed.getUTCSeconds())}`
}

type DeviceGroup = { label: string; rows: GlpiDeviceRow[] }

function groupRows(rows: GlpiDeviceRow[]): DeviceGroup[] {
  const map = new Map<string, GlpiDeviceRow[]>()
  for (const row of rows) {
    const label = (row.group_label || '').trim() || '—'
    const bucket = map.get(label)
    if (bucket) bucket.push(row)
    else map.set(label, [row])
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    .map(([label, items]) => ({ label, rows: items }))
}

export function GlpiDeviceSync({ limit, enabled }: { limit: number; enabled: boolean }) {
  const t = useT()
  const toast = useToast()
  const [kind, setKind] = useState<GlpiDeviceKind>('monitor')
  const [source, setSource] = useState<'corax' | 'glpi'>('corax')
  const [rows, setRows] = useState<GlpiDeviceRow[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [transferring, setTransferring] = useState(false)

  const groups = useMemo(() => groupRows(rows), [rows])

  async function load(nextSource: 'corax' | 'glpi', nextKind = kind) {
    setLoading(true)
    setPicked([])
    try {
      const list =
        nextSource === 'corax'
          ? await api.glpiLocalDevices(nextKind, limit)
          : await api.glpiRemoteDevices(nextKind, limit)
      setSource(nextSource)
      setRows(list)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setLoading(false)
    }
  }

  function toggle(id: number) {
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  function toggleGroup(group: DeviceGroup) {
    const ids = group.rows.map((row) => row.id)
    setPicked((current) => {
      const allOn = ids.every((id) => current.includes(id))
      if (allOn) return current.filter((id) => !ids.includes(id))
      return Array.from(new Set([...current, ...ids]))
    })
  }

  function toggleAll() {
    setPicked((current) => (current.length === rows.length ? [] : rows.map((row) => row.id)))
  }

  async function transfer(all: boolean) {
    if (!all && picked.length === 0) {
      toast.error(t('settingsGlpi.devicesNeedSelection'))
      return
    }
    setTransferring(true)
    try {
      const ids = all ? rows.map((row) => row.id) : picked
      const result: GlpiTicketSyncResult =
        source === 'glpi'
          ? await api.glpiImportDevices(kind, limit, ids)
          : await api.glpiExportDevices(kind, limit, ids)
      const text = t('settingsGlpi.devicesDone', {
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        failed: result.failed,
      })
      if (result.failed > 0) toast.error(result.errors?.[0] ? `${text}. ${result.errors[0]}` : text)
      else toast.ok(result.message ? `${text}. ${result.message}` : text)
      await load(source)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setTransferring(false)
    }
  }

  const busy = loading || transferring
  const allOn = rows.length > 0 && picked.length === rows.length
  const groupHint =
    kind === 'monitor'
      ? t('settingsGlpi.devicesGroupMonitors')
      : kind === 'printer'
        ? t('settingsGlpi.devicesGroupPrinters')
        : t('settingsGlpi.devicesGroupNetwork')

  return (
    <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-3">
      <div>
        <p className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.devicesTitle')}</p>
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.devicesHint')}</p>
        <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{groupHint}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={kind === 'monitor' ? 'app-btn app-btn-primary' : 'app-btn app-btn-secondary'}
          onClick={() => {
            setKind('monitor')
            setRows([])
            setPicked([])
          }}
        >
          {t('settingsGlpi.devicesMonitors')}
        </button>
        <button
          type="button"
          className={kind === 'printer' ? 'app-btn app-btn-primary' : 'app-btn app-btn-secondary'}
          onClick={() => {
            setKind('printer')
            setRows([])
            setPicked([])
          }}
        >
          {t('settingsGlpi.devicesPrinters')}
        </button>
        <button
          type="button"
          className={kind === 'network' ? 'app-btn app-btn-primary' : 'app-btn app-btn-secondary'}
          onClick={() => {
            setKind('network')
            setRows([])
            setPicked([])
          }}
        >
          {t('settingsGlpi.devicesNetwork')}
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void load('corax')}>
          {t('settingsGlpi.devicesFromCorax')}
        </button>
        <button
          type="button"
          className="app-btn app-btn-secondary"
          disabled={busy || !enabled}
          onClick={() => void load('glpi')}
        >
          {t('settingsGlpi.devicesFromGlpi')}
        </button>
        <button
          type="button"
          className="app-btn app-btn-primary"
          disabled={busy || !enabled || rows.length === 0}
          onClick={() => void transfer(false)}
        >
          {t('settingsGlpi.devicesTransferSelected')}
        </button>
        <button
          type="button"
          className="app-btn app-btn-primary"
          disabled={busy || !enabled || rows.length === 0}
          onClick={() => void transfer(true)}
        >
          {t('settingsGlpi.devicesTransferAll')}
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsGlpi.devicesEmpty')}</p>
      ) : (
        <div className="space-y-3">
          <label className="inline-flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
            <input type="checkbox" checked={allOn} onChange={toggleAll} />
            {t('settingsGlpi.devicesSelectAll')} · {picked.length}/{rows.length}
          </label>
          <div className="app-scroll max-h-96 space-y-3 overflow-auto pr-1">
            {groups.map((group) => {
              const groupIds = group.rows.map((row) => row.id)
              const groupOn = groupIds.every((id) => picked.includes(id))
              return (
                <section
                  key={group.label}
                  className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/30"
                >
                  <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                    <label className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
                      <input type="checkbox" checked={groupOn} onChange={() => toggleGroup(group)} />
                      <span className="truncate">{group.label}</span>
                    </label>
                    <span className="text-[11px] tabular-nums text-[var(--color-fg-muted)]">
                      {group.rows.length} · {t('settingsGlpi.devicesGroupCount')}
                    </span>
                  </header>
                  <ul className="divide-y divide-[var(--color-border)]">
                    {group.rows.map((row) => (
                      <li key={`${source}-${row.id}`} className="flex items-start gap-3 px-3 py-2 text-xs">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={picked.includes(row.id)}
                          onChange={() => toggle(row.id)}
                          aria-label={row.name}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-[var(--color-fg)]">{row.name}</div>
                          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[var(--color-fg-muted)]">
                            <span className="tabular-nums">#{row.id}</span>
                            <span className="tabular-nums">GLPI {row.glpi_id ?? '—'}</span>
                            {row.computer_hostname ? (
                              <span>
                                {t('settingsGlpi.devicesColPc')}: {row.computer_hostname}
                              </span>
                            ) : null}
                            {row.ip_address ? (
                              <span>
                                {t('settingsGlpi.devicesColIp')}: {row.ip_address}
                              </span>
                            ) : null}
                            {row.assigned_user ? (
                              <span>
                                {t('settingsGlpi.devicesColUser')}: {row.assigned_user}
                              </span>
                            ) : null}
                            {row.serial_number ? <span>{row.serial_number}</span> : null}
                            <span className="tabular-nums">{formatUtc(row.updated_at)}</span>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
