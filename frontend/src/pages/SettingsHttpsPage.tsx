import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type TlsStatus } from '../api'
import { useAuth } from '../AuthContext'
import { IconLock } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function SettingsHttpsPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [status, setStatus] = useState<TlsStatus | null>(null)
  const [hostnames, setHostnames] = useState('')
  const [days, setDays] = useState(825)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    setLoading(true)
    try {
      const [st, lan] = await Promise.all([api.tlsStatus(), api.agentBundleLanIp().catch(() => null)])
      setStatus(st)
      if (st.hostnames.length > 0) {
        setHostnames(st.hostnames.filter((h) => h !== 'localhost' && h !== '127.0.0.1').join('\n'))
      } else if (lan?.ip) {
        setHostnames(lan.ip)
      } else if (lan?.candidates?.length) {
        setHostnames(lan.candidates.slice(0, 3).join('\n'))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('common.error')
      setLoadError(msg)
      setStatus(null)
      toast.error(msg)
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  function parseHostnames(): string[] {
    return hostnames
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  }

  async function generate(rotateCa: boolean) {
    const names = parseHostnames()
    if (names.length === 0) {
      toast.error(t('settingsHttps.needHosts'))
      return
    }
    setBusy(true)
    try {
      const st = await api.tlsGenerate({ hostnames: names, days, rotate_ca: rotateCa })
      setStatus(st)
      setLoadError(null)
      toast.ok(t('settingsHttps.generated'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function setEnabled(enabled: boolean) {
    setBusy(true)
    try {
      const st = await api.tlsEnable(enabled)
      setStatus(st)
      toast.ok(enabled ? t('settingsHttps.enabled') : t('settingsHttps.disabled'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function downloadCa() {
    setBusy(true)
    try {
      await api.downloadTlsCa()
      toast.ok(t('settingsHttps.caDownloaded'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  const primaryHost =
    status?.hostnames.find((h) => h !== 'localhost' && h !== '127.0.0.1') ||
    status?.hostnames[0] ||
    'SERVER'

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconLock className="h-7 w-7" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.https')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">{t('pages.httpsSubtitle')}</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
      ) : loadError || !status ? (
        <div className="app-card space-y-3 p-4 sm:p-5">
          <p className="text-sm text-[var(--color-fg)]">{loadError || t('common.error')}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.apiMissingHint')}</p>
          <button type="button" className="app-btn app-btn-primary" onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>
      ) : (
        <div className="space-y-6">
          <section className="app-card space-y-3 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.status')}</h2>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[var(--color-fg-subtle)]">{t('settingsHttps.flag')}</dt>
                <dd className="font-medium text-[var(--color-fg)]">
                  {status.enabled ? t('settingsHttps.on') : t('settingsHttps.off')}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--color-fg-subtle)]">{t('settingsHttps.process')}</dt>
                <dd className="font-medium text-[var(--color-fg)]">
                  {status.active ? t('settingsHttps.listeningHttps') : t('settingsHttps.listeningHttp')}
                </dd>
              </div>
              {status.not_after ? (
                <div>
                  <dt className="text-[var(--color-fg-subtle)]">{t('settingsHttps.validUntil')}</dt>
                  <dd className="font-medium text-[var(--color-fg)]">{status.not_after.slice(0, 10)}</dd>
                </div>
              ) : null}
              {status.fingerprint_sha256 ? (
                <div className="sm:col-span-2">
                  <dt className="text-[var(--color-fg-subtle)]">{t('settingsHttps.fingerprint')}</dt>
                  <dd className="break-all font-mono text-xs text-[var(--color-fg)]">{status.fingerprint_sha256}</dd>
                </div>
              ) : null}
            </dl>
            {status.restart_required ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                {t('settingsHttps.restartRequired')}
              </div>
            ) : null}
            {status.dev_blocked ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                {t('settingsHttps.devBlocked')}
              </div>
            ) : null}
            {status.active ? (
              <p className="text-sm text-[var(--color-fg-muted)]">
                {t('settingsHttps.openUrl', { host: primaryHost, port: window.location.port || '3000' })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={busy || !status.files_ready || status.enabled}
                onClick={() => void setEnabled(true)}
              >
                {t('settingsHttps.enable')}
              </button>
              <button
                type="button"
                className="app-btn app-btn-secondary"
                disabled={busy || !status.enabled}
                onClick={() => void setEnabled(false)}
              >
                {t('settingsHttps.disable')}
              </button>
            </div>
          </section>

          <section className="app-card space-y-3 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.create')}</h2>
            <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.createHint')}</p>
            <label className="block">
              <span className="app-label">{t('settingsHttps.hostnames')}</span>
              <textarea
                className="app-input min-h-[5.5rem] font-mono text-sm"
                value={hostnames}
                onChange={(e) => setHostnames(e.target.value)}
                placeholder={t('settingsHttps.hostnamesPh')}
                disabled={busy}
              />
            </label>
            <label className="block max-w-xs">
              <span className="app-label">{t('settingsHttps.days')}</span>
              <input
                type="number"
                className="app-input"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => {
                  const n = Number(e.target.value)
                  setDays(Number.isFinite(n) ? Math.min(3650, Math.max(1, Math.trunc(n))) : 825)
                }}
                disabled={busy}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={busy}
                onClick={() => void generate(false)}
              >
                {status.files_ready ? t('settingsHttps.reissue') : t('settingsHttps.generate')}
              </button>
              {status.ca_ready ? (
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={busy}
                  onClick={() => void generate(true)}
                >
                  {t('settingsHttps.rotateCa')}
                </button>
              ) : null}
            </div>
          </section>

          <section className="app-card space-y-3 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.trustTitle')}</h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--color-fg-muted)]">
              <li>{t('settingsHttps.trustStep1')}</li>
              <li>{t('settingsHttps.trustStep2')}</li>
              <li>{t('settingsHttps.trustStep3')}</li>
              <li>{t('settingsHttps.trustFirefox')}</li>
              <li>{t('settingsHttps.trustYandex')}</li>
            </ol>
            <p className="text-xs text-[var(--color-fg-subtle)]">{t('settingsHttps.trustReality')}</p>
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy || !status.ca_ready}
              onClick={() => void downloadCa()}
            >
              {t('settingsHttps.downloadCa')}
            </button>
            <p className="text-xs text-[var(--color-fg-subtle)]">{t('settingsHttps.agentsNote')}</p>
          </section>
        </div>
      )}
    </div>
  )
}
