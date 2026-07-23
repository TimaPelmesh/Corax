import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type TlsMode, type TlsStatus } from '../api'
import { useAuth } from '../AuthContext'
import { IconLock } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

const MODES: TlsMode[] = ['http', 'local_ca', 'enterprise']

export function SettingsHttpsPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [status, setStatus] = useState<TlsStatus | null>(null)
  const [hostnames, setHostnames] = useState('')
  const [days, setDays] = useState(825)
  const [pickMode, setPickMode] = useState<TlsMode>('http')
  const [certPem, setCertPem] = useState('')
  const [keyPem, setKeyPem] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    setLoading(true)
    try {
      const [st, lan] = await Promise.all([api.tlsStatus(), api.agentBundleLanIp().catch(() => null)])
      setStatus(st)
      setPickMode((st.mode as TlsMode) || (st.enabled ? 'local_ca' : 'http'))
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

  function modeLabel(m: TlsMode): string {
    if (m === 'http') return t('settingsHttps.modeHttp')
    if (m === 'enterprise') return t('settingsHttps.modeEnterprise')
    return t('settingsHttps.modeLocalCa')
  }

  function modeHint(m: TlsMode): string {
    if (m === 'http') return t('settingsHttps.modeHttpHint')
    if (m === 'enterprise') return t('settingsHttps.modeEnterpriseHint')
    return t('settingsHttps.modeLocalCaHint')
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
      setPickMode((st.mode as TlsMode) || 'local_ca')
      setLoadError(null)
      toast.ok(t('settingsHttps.generated'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function applyMode() {
    setBusy(true)
    try {
      const st = await api.tlsSetMode(pickMode)
      setStatus(st)
      setPickMode((st.mode as TlsMode) || pickMode)
      toast.ok(t('settingsHttps.modeApplied'))
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
      setPickMode((st.mode as TlsMode) || (enabled ? 'local_ca' : 'http'))
      toast.ok(enabled ? t('settingsHttps.enabled') : t('settingsHttps.disabled'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setBusy(false)
    }
  }

  async function importEnterprise() {
    if (!certPem.trim() || !keyPem.trim()) {
      toast.error(t('settingsHttps.needImport'))
      return
    }
    setBusy(true)
    try {
      const st = await api.tlsImport({ cert_pem: certPem.trim(), key_pem: keyPem.trim() })
      setStatus(st)
      setPickMode('enterprise')
      setKeyPem('')
      toast.ok(t('settingsHttps.imported'))
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
      <PageHeader
        icon={<IconLock className="h-7 w-7" />}
        title={t('titles.https')}
        subtitle={t('pages.httpsSubtitle')}
      />

      {loading ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
      ) : loadError || !status ? (
        <div className="app-card space-y-3 p-6 sm:p-7">
          <p className="text-sm text-[var(--color-fg)]">{loadError || t('common.error')}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.apiMissingHint')}</p>
          <button type="button" className="app-btn app-btn-primary" onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>
      ) : (
        <div className="max-w-3xl space-y-6">
          {status.restart_required ? (
            <div className="app-alert app-alert-warning text-sm" role="status">
              <p className="font-medium">{t('settingsHttps.restartRequired')}</p>
              <p className="mt-1 text-xs opacity-90">
                {status.enabled && !status.active
                  ? t('settingsHttps.restartBannerHttps')
                  : t('settingsHttps.restartBannerHttp')}
              </p>
            </div>
          ) : null}
          {status.dev_blocked ? (
            <div className="app-alert app-alert-warning text-sm">{t('settingsHttps.devBlocked')}</div>
          ) : null}

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.mode')}</h2>
            <div className="space-y-2">
              {MODES.map((m) => (
                <label
                  key={m}
                  className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-3 transition-colors ${
                    pickMode === m
                      ? 'border-[var(--color-primary)] bg-[var(--color-surface-muted)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                  }`}
                >
                  <input
                    type="radio"
                    className="mt-1"
                    name="tls-mode"
                    checked={pickMode === m}
                    onChange={() => setPickMode(m)}
                    disabled={busy}
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-[var(--color-fg)]">{modeLabel(m)}</span>
                    <span className="mt-0.5 block text-xs text-[var(--color-fg-muted)]">{modeHint(m)}</span>
                  </span>
                </label>
              ))}
            </div>
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy || pickMode === status.mode}
              onClick={() => void applyMode()}
            >
              {t('settingsHttps.applyMode')}
            </button>
          </section>

          <section className="app-card space-y-3 p-6 sm:p-7">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.status')}</h2>
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-[var(--color-fg-subtle)]">{t('settingsHttps.mode')}</dt>
                <dd className="font-medium text-[var(--color-fg)]">
                  {modeLabel((status.mode as TlsMode) || 'http')}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--color-fg-subtle)]">{t('settingsHttps.agentScheme')}</dt>
                <dd className="font-mono font-medium text-[var(--color-fg)]">
                  {(status.agent_scheme || 'http').toUpperCase()}
                </dd>
              </div>
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
            {status.active ? (
              <p className="text-sm text-[var(--color-fg-muted)]">
                {t('settingsHttps.openUrl', { host: primaryHost, port: window.location.port || '3000' })}
              </p>
            ) : null}
            <p className="text-xs text-[var(--color-fg-subtle)]">{t('settingsHttps.agentsNote')}</p>
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
                disabled={busy || (!status.enabled && status.mode === 'http')}
                onClick={() => void setEnabled(false)}
              >
                {t('settingsHttps.disable')}
              </button>
            </div>
          </section>

          <section className="app-card space-y-3 p-6 sm:p-7">
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
                {status.files_ready && status.ca_ready ? t('settingsHttps.reissue') : t('settingsHttps.generate')}
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

          <section className="app-card space-y-3 p-6 sm:p-7">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.importTitle')}</h2>
            <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.importHint')}</p>
            <label className="block">
              <span className="app-label">{t('settingsHttps.certPem')}</span>
              <textarea
                className="app-input min-h-[6rem] font-mono text-xs"
                value={certPem}
                onChange={(e) => setCertPem(e.target.value)}
                disabled={busy}
                spellCheck={false}
              />
            </label>
            <label className="block">
              <span className="app-label">{t('settingsHttps.keyPem')}</span>
              <textarea
                className="app-input min-h-[5rem] font-mono text-xs"
                value={keyPem}
                onChange={(e) => setKeyPem(e.target.value)}
                disabled={busy}
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="app-btn app-btn-primary"
              disabled={busy}
              onClick={() => void importEnterprise()}
            >
              {t('settingsHttps.importBtn')}
            </button>
          </section>

          <section className="app-card space-y-3 p-6 sm:p-7">
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
          </section>
        </div>
      )}
    </div>
  )
}
