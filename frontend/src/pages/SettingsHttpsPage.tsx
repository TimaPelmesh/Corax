import { useCallback, useEffect, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type TlsMode, type TlsStatus } from '../api'
import { useAuth } from '../AuthContext'
import { IconLock } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { SettingsStatusBoard, type StatusFact } from '../components/settings/SettingsStatusBoard'
import { AppFold } from '../components/ui/AppFold'
import { Skeleton } from '../components/Skeleton'
import { StatusPill, type StatusPillTone } from '../components/ui/StatusPill'
import { useLocale, useT, type MessageKey } from '../i18n/LocaleContext'
import { httpsPhase, pluralKind, type CertClock, type HttpsPhase } from '../lib/settingsOpsStatus'
import { useToast } from '../ToastContext'

const MODES: TlsMode[] = ['http', 'local_ca', 'enterprise']

function panelAddress(status: TlsStatus, host: string) {
  const scheme = status.active ? 'https' : 'http'
  const port = window.location.port || '3000'
  return `${scheme}://${host}:${port}`
}

export function SettingsHttpsPage() {
  const t = useT()
  const { locale } = useLocale()
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

  function modeShort(m: TlsMode): string {
    if (m === 'http') return t('settingsHttps.modeHttpShort')
    if (m === 'enterprise') return t('settingsHttps.modeEnterpriseShort')
    return t('settingsHttps.modeLocalCaShort')
  }

  function modeHint(m: TlsMode): string {
    if (m === 'http') return t('settingsHttps.modeHttpHint')
    if (m === 'enterprise') return t('settingsHttps.modeEnterpriseHint')
    return t('settingsHttps.modeLocalCaHint')
  }

  function unit(n: number) {
    const kind = pluralKind(n, locale)
    if (kind === 'one') return t('settingsHttps.dayOne')
    if (kind === 'few') return t('settingsHttps.dayFew')
    return t('settingsHttps.dayMany')
  }

  function when(n: number) {
    return t('settingsHttps.factDays', { n, unit: unit(n) })
  }

  function certValue(clock: CertClock): string {
    if (clock.phase === 'missing') return t('settingsHttps.factNoCert')
    if (clock.phase === 'today') return t('settingsHttps.factToday')
    if (clock.phase === 'expired') {
      if (!clock.overdueDays) return t('settingsHttps.factExpired')
      return t('settingsHttps.factOverdue', { when: when(clock.overdueDays) })
    }
    return when(clock.daysLeft ?? 0)
  }

  function certDetail(phase: HttpsPhase, clock: CertClock, current: TlsStatus): string {
    if (phase === 'http') return t('settingsHttps.httpDetail')
    if (phase === 'restart') {
      return current.active && !current.enabled
        ? t('settingsHttps.restartHttpDetail')
        : t('settingsHttps.pendingDetail')
    }
    if (phase === 'ready') return t('settingsHttps.readyDetail')
    if (phase === 'expired') {
      if (!clock.overdueDays) return t('settingsHttps.expiredToday')
      return t('settingsHttps.expiredAgo', { when: when(clock.overdueDays) })
    }
    if (clock.phase === 'today') return t('settingsHttps.expiresToday')
    if (clock.phase === 'missing' || clock.daysLeft == null) return ''
    const sentence = t('settingsHttps.expiresIn', { when: when(clock.daysLeft) })
    return phase === 'soon' ? `${sentence} ${t('settingsHttps.soonHint')}` : sentence
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast.ok(t('settingsHttps.copied'))
    } catch {
      toast.error(t('settingsHttps.copyFailed'))
    }
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
    window.location.hostname ||
    'SERVER'
  const live = status ? httpsPhase(status) : null
  const address = status ? panelAddress(status, primaryHost) : ''

  const phaseTone: Record<HttpsPhase, StatusPillTone> = {
    live: 'success',
    soon: 'warning',
    expired: 'error',
    restart: 'warning',
    ready: 'info',
    http: 'info',
  }
  const phaseTitle: Record<HttpsPhase, MessageKey> = {
    live: 'settingsHttps.liveTitle',
    soon: 'settingsHttps.liveTitle',
    expired: 'settingsHttps.expiredTitle',
    restart: 'settingsHttps.restartTitle',
    ready: 'settingsHttps.readyTitle',
    http: 'settingsHttps.httpTitle',
  }
  const phaseKicker: Record<HttpsPhase, MessageKey> = {
    live: 'settingsHttps.kickerLive',
    soon: 'settingsHttps.kickerLive',
    expired: 'settingsHttps.kickerExpired',
    restart: 'settingsHttps.kickerRestart',
    ready: 'settingsHttps.kickerReady',
    http: 'settingsHttps.kickerLive',
  }

  const facts: StatusFact[] = live
    ? [
        {
          label: t('settingsHttps.factListen'),
          value: status?.active ? t('settingsHttps.listenHttps') : t('settingsHttps.listenHttp'),
        },
        {
          label: t('settingsHttps.factCert'),
          value: certValue(live.clock),
          title: status?.not_after ? status.not_after.slice(0, 10) : undefined,
        },
        {
          label: t('settingsHttps.factAgents'),
          value: (status?.agent_scheme || 'http').toUpperCase(),
        },
        {
          label: t('settingsHttps.factAddress'),
          value: address,
          mono: true,
        },
      ]
    : []

  return (
    <div className="settings-page settings-page--wide">
      <PageHeader
        icon={<IconLock className="h-7 w-7" />}
        title={t('titles.https')}
        subtitle={t('pages.httpsSubtitle')}
      />

      {loading ? (
        <div className="space-y-3" role="status" aria-busy="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-36 w-full rounded-xl" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : loadError || !status || !live ? (
        <div className="app-panel space-y-3">
          <p className="text-sm text-[var(--color-fg)]">{loadError || t('common.error')}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.apiMissingHint')}</p>
          <button type="button" className="app-btn app-btn-primary w-full sm:w-auto" onClick={() => void load()}>
            {t('common.refresh')}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <SettingsStatusBoard
            tone={phaseTone[live.phase]}
            kicker={t(phaseKicker[live.phase])}
            title={t(phaseTitle[live.phase])}
            detail={certDetail(live.phase, live.clock, status)}
            facts={facts}
            actions={
              <>
                <button
                  type="button"
                  className="app-btn app-btn-secondary w-full !min-h-9 sm:w-auto"
                  onClick={() => void copyText(address)}
                >
                  {t('settingsHttps.copyAddress')}
                </button>
                {status.ca_ready && (status.mode === 'local_ca' || pickMode === 'local_ca') ? (
                  <button
                    type="button"
                    className="app-btn app-btn-secondary w-full !min-h-9 sm:w-auto"
                    disabled={busy}
                    onClick={() => void downloadCa()}
                  >
                    {t('settingsHttps.downloadCa')}
                  </button>
                ) : null}
              </>
            }
            extra={
              status.fingerprint_sha256 ? (
                <div className="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-[11px] font-medium text-[var(--color-fg-subtle)]">
                      {t('settingsHttps.fingerprint')}
                    </div>
                    <div className="truncate font-mono text-xs text-[var(--color-fg)]" title={status.fingerprint_sha256}>
                      {status.fingerprint_sha256}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="app-btn app-btn-secondary w-full !min-h-9 shrink-0 sm:w-auto"
                    onClick={() => void copyText(status.fingerprint_sha256 || '')}
                  >
                    {t('settingsHttps.copyFingerprint')}
                  </button>
                </div>
              ) : null
            }
          />

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

          <section className="app-panel space-y-3 !p-4 sm:!p-5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.mode')}</h2>
              {pickMode !== status.mode ? (
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t('settingsHttps.modeDirty', { mode: modeShort(status.mode as TlsMode) })}
                </p>
              ) : null}
            </div>
            <div className="grid gap-2 lg:grid-cols-3">
              {MODES.map((m) => {
                const selected = pickMode === m
                const current = status.mode === m
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={busy}
                    aria-pressed={selected}
                    onClick={() => setPickMode(m)}
                    className={`flex min-h-[7.5rem] flex-col rounded-xl border px-3 py-3 text-left transition ${
                      selected
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-muted)]'
                        : 'border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]'
                    }`}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--color-fg)]">{modeShort(m)}</span>
                      {current ? <StatusPill tone={selected ? 'info' : 'neutral'}>{t('settingsHttps.modeNow')}</StatusPill> : null}
                    </span>
                    <span className="mt-1 text-[11px] font-medium text-[var(--color-fg-subtle)]">{modeLabel(m)}</span>
                    <span className="mt-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">{modeHint(m)}</span>
                  </button>
                )
              })}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                className="app-btn app-btn-primary w-full sm:w-auto"
                disabled={busy || pickMode === status.mode}
                onClick={() => void applyMode()}
              >
                {t('settingsHttps.applyMode')}
              </button>
              {pickMode !== 'http' ? (
                <button
                  type="button"
                  className="app-btn app-btn-secondary w-full sm:w-auto"
                  disabled={busy || !status.files_ready || status.enabled}
                  onClick={() => void setEnabled(true)}
                >
                  {t('settingsHttps.enable')}
                </button>
              ) : null}
              <button
                type="button"
                className="app-btn app-btn-secondary w-full sm:w-auto"
                disabled={busy || (!status.enabled && status.mode === 'http')}
                onClick={() => void setEnabled(false)}
              >
                {t('settingsHttps.disable')}
              </button>
            </div>
            <p className="text-xs leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsHttps.agentsNote')}</p>
          </section>

          {pickMode === 'local_ca' ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="app-panel space-y-3">
                <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.create')}</h2>
                <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.createHint')}</p>
                {status.hostnames.length > 0 ? (
                  <p className="text-xs text-[var(--color-fg-muted)]">
                    {t('settingsHttps.inCert', { hosts: status.hostnames.join(', ') })}
                  </p>
                ) : null}
                <label className="block">
                  <span className="app-label">{t('settingsHttps.hostnames')}</span>
                  <textarea
                    className="app-input min-h-[5rem] font-mono text-sm"
                    value={hostnames}
                    onChange={(e) => setHostnames(e.target.value)}
                    placeholder={t('settingsHttps.hostnamesPh')}
                    disabled={busy}
                  />
                </label>
                <label className="block max-w-[10rem]">
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
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <button
                    type="button"
                    className="app-btn app-btn-primary w-full sm:w-auto"
                    disabled={busy}
                    onClick={() => void generate(false)}
                  >
                    {status.files_ready && status.ca_ready ? t('settingsHttps.reissue') : t('settingsHttps.generate')}
                  </button>
                  {status.ca_ready ? (
                    <button
                      type="button"
                      className="app-btn app-btn-secondary w-full sm:w-auto"
                      disabled={busy}
                      onClick={() => void generate(true)}
                    >
                      {t('settingsHttps.rotateCa')}
                    </button>
                  ) : null}
                </div>
              </section>
              <AppFold title={t('settingsHttps.trustTitle')} defaultOpen={!status.ca_ready}>
                <ol className="list-decimal space-y-1.5 pl-5 text-sm text-[var(--color-fg-muted)]">
                  <li>{t('settingsHttps.trustStep1')}</li>
                  <li>{t('settingsHttps.trustStep2')}</li>
                  <li>{t('settingsHttps.trustStep3')}</li>
                  <li>{t('settingsHttps.trustFirefox')}</li>
                  <li>{t('settingsHttps.trustYandex')}</li>
                </ol>
                <p className="text-xs text-[var(--color-fg-subtle)]">{t('settingsHttps.trustReality')}</p>
                <button
                  type="button"
                  className="app-btn app-btn-primary w-full sm:w-auto"
                  disabled={busy || !status.ca_ready}
                  onClick={() => void downloadCa()}
                >
                  {t('settingsHttps.downloadCa')}
                </button>
              </AppFold>
            </div>
          ) : null}

          {pickMode === 'enterprise' ? (
            <section className="app-panel space-y-3">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsHttps.importTitle')}</h2>
              <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsHttps.importHint')}</p>
              <div className="grid gap-3 lg:grid-cols-2">
                <label className="block">
                  <span className="app-label">{t('settingsHttps.certPem')}</span>
                  <textarea
                    className="app-input min-h-[8rem] font-mono text-xs"
                    value={certPem}
                    onChange={(e) => setCertPem(e.target.value)}
                    disabled={busy}
                    spellCheck={false}
                  />
                </label>
                <label className="block">
                  <span className="app-label">{t('settingsHttps.keyPem')}</span>
                  <textarea
                    className="app-input min-h-[8rem] font-mono text-xs"
                    value={keyPem}
                    onChange={(e) => setKeyPem(e.target.value)}
                    disabled={busy}
                    spellCheck={false}
                  />
                </label>
              </div>
              <button
                type="button"
                className="app-btn app-btn-primary w-full sm:w-auto"
                disabled={busy}
                onClick={() => void importEnterprise()}
              >
                {t('settingsHttps.importBtn')}
              </button>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
