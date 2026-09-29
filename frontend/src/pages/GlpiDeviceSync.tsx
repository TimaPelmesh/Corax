import { useState } from 'react'
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

export function GlpiDeviceSync({ limit, enabled }: { limit: number; enabled: boolean }) {
  const t = useT()
  const toast = useToast()
  const [kind, setKind] = useState<GlpiDeviceKind>('monitor')
  const [source, setSource] = useState<'corax' | 'glpi'>('corax')
  const [rows, setRows] = useState<GlpiDeviceRow[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [loading, setLoading] = useState(false)
  const [transferring, setTransferring] = useState(false)

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

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
      <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.devicesHint')}</p>
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
        <div className="app-scroll max-h-80 overflow-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-[var(--color-surface)]">
              <tr className="border-b border-[var(--color-border)] text-[var(--color-fg-muted)]">
                <th className="px-2 py-2">
                  <label className="inline-flex items-center gap-2">
                    <input type="checkbox" checked={allOn} onChange={toggleAll} aria-label={t('settingsGlpi.devicesSelectAll')} />
                    {t('settingsGlpi.devicesSelectAll')}
                  </label>
                </th>
                <th className="px-2 py-2">{t('settingsGlpi.devicesColId')}</th>
                <th className="px-2 py-2">{t('settingsGlpi.devicesColGlpi')}</th>
                <th className="px-2 py-2">{t('settingsGlpi.devicesColName')}</th>
                <th className="px-2 py-2">{t('settingsGlpi.devicesColSerial')}</th>
                <th className="px-2 py-2">{t('settingsGlpi.devicesColInventory')}</th>
                <th className="px-2 py-2">{t('settingsGlpi.devicesColUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${source}-${row.id}`} className="border-b border-[var(--color-border)]">
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      checked={picked.includes(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={row.name}
                    />
                  </td>
                  <td className="px-2 py-1.5 tabular-nums">{row.id}</td>
                  <td className="px-2 py-1.5 tabular-nums">{row.glpi_id ?? '—'}</td>
                  <td className="px-2 py-1.5">{row.name}</td>
                  <td className="px-2 py-1.5">{row.serial_number || '—'}</td>
                  <td className="px-2 py-1.5">{row.inventory_number || '—'}</td>
                  <td className="px-2 py-1.5 tabular-nums">{formatUtc(row.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
