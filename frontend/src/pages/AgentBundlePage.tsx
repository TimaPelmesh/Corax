import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { api, type AgentBundleProfile, type AgentBundleTarget } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { buildAgentServerUrl, schemeFromTls, type AgentUrlScheme } from '../lib/agentServerUrl'
import { useToast } from '../ToastContext'
import { EmployeePortalTabsPanel } from './EmployeePortalTabsPanel'

const MODULE_KEYS = [
  'patches',
  'network',
  'domain_sessions',
  'bitlocker',
  'tpm_secureboot',
  'antivirus',
  'startup',
  'services',
  'storage_health',
  'battery',
  'windows_features',
  'office',
  'usb_history',
  'docker_wsl',
] as const

/** Prod/Docker = :3000 (UI+API). Dev split uses :3001 for API — take from address bar when possible. */
function defaultAgentPort(): string {
  if (typeof window === 'undefined') return '3000'
  const p = (window.location.port || '').trim()
  if (p) return p
  if (window.location.protocol === 'https:') return '443'
  return '3000'
}

/** Docker / compose bridge pools — unreachable from LAN PCs. */
function isDockerBridgeIp(ip: string): boolean {
  const m = /^172\.(1[7-9]|2\d)\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  return Boolean(m)
}

/** If admin opened the panel via LAN IP/hostname, that is the URL agents must use (not Docker 172.x). */
function hostFromBrowser(): string {
  if (typeof window === 'undefined') return ''
  const h = (window.location.hostname || '').trim().toLowerCase()
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1') return ''
  if (isDockerBridgeIp(h)) return ''
  return window.location.hostname.trim()
}

function usableLanIp(ip: string | null | undefined): string {
  const v = (ip || '').trim()
  if (!v || isDockerBridgeIp(v)) return ''
  return v
}

export function AgentBundlePage() {
  const t = useT()
  const toast = useToast()
  const { user, loading: authLoading } = useAuth()
  const [serverHost, setServerHost] = useState(() => hostFromBrowser())
  const [lanCandidates, setLanCandidates] = useState<string[]>([])
  const [lanLoading, setLanLoading] = useState(true)
  const [serverPort, setServerPort] = useState(() => defaultAgentPort())
  const [platform, setPlatform] = useState<AgentBundleTarget>('windows')
  const [level, setLevel] = useState<AgentBundleProfile>('full')
  const [tokenLabel, setTokenLabel] = useState('CORAX deploy')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [auditIntervalSec, setAuditIntervalSec] = useState(60)
  const [installCommand, setInstallCommand] = useState('')
  const [installToken, setInstallToken] = useState('')
  const [sshHost, setSshHost] = useState('')
  const [sshPort, setSshPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [sshPassword, setSshPassword] = useState('')
  const [sshBusy, setSshBusy] = useState(false)
  const [sshOutput, setSshOutput] = useState('')
  const [winHost, setWinHost] = useState('')
  const [winPort, setWinPort] = useState('5985')
  const [winUser, setWinUser] = useState('')
  const [winPassword, setWinPassword] = useState('')
  const [winBusy, setWinBusy] = useState(false)
  const [winOutput, setWinOutput] = useState('')
  const [scheduleMode, setScheduleMode] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [fleetMode, setFleetMode] = useState<'on_demand' | 'daily' | 'weekly'>('on_demand')
  const [fleetTime, setFleetTime] = useState('09:00')
  const [fleetWeekday, setFleetWeekday] = useState(0)
  const [fleetBusy, setFleetBusy] = useState(false)
  const [modules, setModules] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MODULE_KEYS.map((k) => [k, true])),
  )
  const [busy, setBusy] = useState(false)
  const [urlScheme, setUrlScheme] = useState<AgentUrlScheme>(() =>
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http',
  )

  const serverUrl = useMemo(
    () => buildAgentServerUrl(serverHost, serverPort, urlScheme),
    [serverHost, serverPort, urlScheme],
  )

  useEffect(() => {
    setInstallCommand('')
  }, [serverUrl, auditIntervalSec])

  useEffect(() => {
    if (authLoading || !user?.is_superuser) return
    let cancelled = false
    void api
      .tlsStatus()
      .then((st) => {
        if (cancelled) return
        setUrlScheme(schemeFromTls(st.agent_scheme, st.active, st.enabled))
      })
      .catch(() => {
        /* keep browser protocol fallback */
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, user?.is_superuser])

  useEffect(() => {
    if (authLoading || !user?.is_superuser) return
    let cancelled = false
    void api.agentCollectPolicy().then((policy) => {
      if (cancelled) return
      setFleetMode(policy.mode)
      setFleetTime(policy.time_hhmm || '09:00')
      setFleetWeekday(policy.weekday ?? 0)
    }).catch(() => {
      /* policy appears after the API migration; the form keeps defaults */
    })
    return () => {
      cancelled = true
    }
  }, [authLoading, user?.is_superuser])

  useEffect(() => {
    if (authLoading || !user?.is_superuser) return
    let cancelled = false
    setLanLoading(true)
    void api
      .agentBundleLanIp()
      .then((r) => {
        if (cancelled) return
        const fromApi = (r.candidates ?? []).map((x) => usableLanIp(x)).filter(Boolean)
        const browserHost = hostFromBrowser()
        const preferred =
          usableLanIp(browserHost) || usableLanIp(r.ip) || fromApi[0] || ''
        const merged = [
          ...(preferred ? [preferred] : []),
          ...fromApi.filter((ip) => ip !== preferred),
        ]
        setLanCandidates(merged)
        setServerHost(preferred)
      })
      .catch((ex) => {
        if (cancelled) return
        const browserHost = hostFromBrowser()
        if (browserHost) {
          setServerHost(browserHost)
          setLanCandidates([browserHost])
          return
        }
        toast.error(ex instanceof Error ? ex.message : t('agentBundle.lanDetectFailed'))
      })
      .finally(() => {
        if (!cancelled) setLanLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, t, toast, user?.is_superuser])

  const showModules = (platform === 'windows' || platform === 'linux') && level === 'custom'
  const showExtended = platform === 'windows' || platform === 'linux'
  const moduleList = useMemo(() => [...MODULE_KEYS], [])
  const enabledModuleCount = useMemo(
    () => Object.values(modules).filter(Boolean).length,
    [modules],
  )

  if (authLoading) {
    return <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  function toggleModule(key: string) {
    setModules((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function linuxPayload() {
    const label = tokenLabel.trim() || t('agentBundle.defaultTokenLabelLinux')
    return {
      server_url: buildAgentServerUrl(serverHost, serverPort, urlScheme),
      target: 'linux' as const,
      profile: showExtended ? level : ('full' as const),
      create_token: true,
      token_label: label,
      existing_token: installToken || null,
      modules: showModules ? modules : undefined,
      schedule: {
        enabled: scheduleEnabled,
        mode: scheduleMode,
        time: scheduleTime,
        weekday: 'MON' as const,
        task_name: 'CORAX-Agent-Linux',
      },
      audit_interval_seconds: auditIntervalSec,
    }
  }

  function requireServer(): boolean {
    if (!serverHost.trim()) {
      toast.error(t('agentBundle.serverHostRequired'))
      return false
    }
    if (isDockerBridgeIp(serverHost)) {
      toast.error(t('agentBundle.dockerBridgeIp'))
      return false
    }
    return true
  }

  async function onInstallCommand() {
    if (!requireServer()) return
    setBusy(true)
    try {
      const result = await api.linuxInstallCommand(linuxPayload())
      setInstallToken(result.token)
      setInstallCommand(result.command)
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : t('agentBundle.buildError'))
    } finally {
      setBusy(false)
    }
  }

  async function onCopyCommand() {
    try {
      await navigator.clipboard.writeText(installCommand)
      toast.ok(t('agentBundle.installCopied'))
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : t('agentBundle.buildError'))
    }
  }

  async function onSshInstall() {
    if (!requireServer()) return
    const port = Number(sshPort)
    if (!sshHost.trim() || !sshUser.trim() || !sshPassword || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t('agentBundle.buildError'))
      return
    }
    setSshBusy(true)
    setSshOutput('')
    try {
      const result = await api.linuxSshInstall({
        ...linuxPayload(),
        ssh_host: sshHost.trim(),
        ssh_port: port,
        ssh_user: sshUser.trim(),
        ssh_password: sshPassword,
      })
      setSshPassword('')
      if (result.token) setInstallToken(result.token)
      setSshOutput(result.output || String(result.exit_code))
      if (result.ok) toast.ok(t('agentBundle.installSshOk'))
      else toast.error((result.output || t('agentBundle.buildError')).split('\n')[0]?.slice(0, 240) || t('agentBundle.buildError'))
    } catch (ex) {
      setSshPassword('')
      toast.error(ex instanceof Error ? ex.message : t('agentBundle.buildError'))
    } finally {
      setSshBusy(false)
    }
  }

  async function onWinrmInstall() {
    if (!requireServer()) return
    const port = Number(winPort)
    if (!winHost.trim() || !winUser.trim() || !winPassword || !Number.isInteger(port) || port < 1 || port > 65535) {
      toast.error(t('agentBundle.buildError'))
      return
    }
    setWinBusy(true)
    setWinOutput('')
    try {
      const result = await api.windowsWinrmInstall({
        server_url: buildAgentServerUrl(serverHost, serverPort, urlScheme),
        target: 'windows',
        profile: showExtended ? level : 'full',
        create_token: true,
        token_label: tokenLabel.trim() || t('agentBundle.defaultTokenLabelWin10'),
        modules: showModules ? modules : undefined,
        schedule: {
          enabled: scheduleEnabled,
          mode: scheduleMode,
          time: scheduleTime,
          weekday: 'MON',
          task_name: 'CORAX-Agent',
        },
        winrm_host: winHost.trim(),
        winrm_port: port,
        winrm_user: winUser.trim(),
        winrm_password: winPassword,
      })
      setWinPassword('')
      setWinOutput(result.output || String(result.exit_code))
      if (result.ok) toast.ok(t('agentBundle.installWinrmOk'))
      else toast.error((result.output || t('agentBundle.buildError')).split('\n')[0]?.slice(0, 240) || t('agentBundle.buildError'))
    } catch (ex) {
      setWinPassword('')
      toast.error(ex instanceof Error ? ex.message : t('agentBundle.buildError'))
    } finally {
      setWinBusy(false)
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!serverHost.trim()) {
      toast.error(t('agentBundle.serverHostRequired'))
      return
    }
    if (isDockerBridgeIp(serverHost)) {
      toast.error(t('agentBundle.dockerBridgeIp'))
      return
    }
    setBusy(true)
    try {
      const label =
        tokenLabel.trim() ||
        (platform === 'linux' ? t('agentBundle.defaultTokenLabelLinux') : t('agentBundle.defaultTokenLabelWin10'))
      const server = buildAgentServerUrl(serverHost, serverPort, urlScheme)
      const filename = await api.downloadAgentBundle({
            server_url: server,
            target: platform,
            profile: showExtended ? level : 'full',
            create_token: platform === 'linux',
            token_label: label,
            modules: showModules ? modules : undefined,
            schedule:
              platform === 'windows' || platform === 'linux'
                ? {
                    enabled: scheduleEnabled,
                    mode: scheduleMode,
                    time: scheduleTime,
                    weekday: 'MON',
                    task_name: platform === 'linux' ? 'CORAX-Agent-Linux' : 'CORAX-Agent',
                  }
                : { enabled: false },
            audit_interval_seconds: platform === 'linux' ? auditIntervalSec : null,
          })
      toast.ok(t('agentBundle.downloadSuccess', { filename }))
    } catch (ex) {
      let msg = ex instanceof Error ? ex.message : t('agentBundle.buildError')
      if (msg.includes('Method Not Allowed') || msg.includes('405')) {
        msg += t('agentBundle.apiNotRespondingSuffix')
      }
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <PageHeader
        icon={<IconKey className="h-7 w-7" />}
        title={t('titles.agentBundle')}
        subtitle={t('pages.agentBundleSubtitle')}
        actions={
          <div className="inline-flex max-w-full flex-wrap rounded-lg border border-[var(--color-border)] p-0.5">
            {(
              [
                ['windows', 'agentBundle.platformWin10'],
                ['linux', 'agentBundle.platformLinux'],
              ] as const
            ).map(([id, key]) => (
              <button
                key={id}
                type="button"
                onClick={() => setPlatform(id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  platform === id
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]'
                }`}
              >
                {t(key)}
              </button>
            ))}
          </div>
        }
      />

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,22rem)] xl:grid-cols-[minmax(0,1fr)_24rem]"
      >
        <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] min-w-0 space-y-5 p-5">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            {t('agentBundle.parametersTitle')}
          </h2>

          <div className="grid gap-3 sm:grid-cols-[1fr_7rem_6.5rem]">
            <div>
              <label className="app-label">{t('agentBundle.serverIpLabel')}</label>
              {lanCandidates.length > 1 ? (
                <select
                  className="app-input font-mono text-sm"
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  required
                >
                  {!serverHost ? <option value="">{t('agentBundle.chooseInterface')}</option> : null}
                  {lanCandidates.map((ip) => (
                    <option key={ip} value={ip}>
                      {ip}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="app-input font-mono text-sm"
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  placeholder={lanLoading ? t('agentBundle.detectingLanIp') : '192.168.1.10'}
                  required
                />
              )}
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {lanLoading
                  ? t('agentBundle.detectingLanIpHint')
                  : t('agentBundle.serverIpHint')}
              </p>
            </div>
            <div>
              <label className="app-label">{t('agentBundle.portLabel')}</label>
              <input
                className="app-input font-mono text-sm"
                value={serverPort}
                onChange={(e) => setServerPort(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="3000"
                required
              />
            </div>
            <div>
              <label className="app-label">{t('agentBundle.schemeLabel')}</label>
              <select
                className="app-input font-mono text-sm"
                value={urlScheme}
                onChange={(e) => setUrlScheme(e.target.value === 'https' ? 'https' : 'http')}
              >
                <option value="http">http</option>
                <option value="https">https</option>
              </select>
            </div>
          </div>
          <p className="-mt-2 text-xs text-[var(--color-fg-muted)]">
            {t('agentBundle.agentUrl')} <code className="font-mono">{serverUrl}</code>
          </p>
          <p className="text-xs text-[var(--color-fg-subtle)]">{t('agentBundle.schemeHint')}</p>
          {urlScheme === 'http' ? (
            <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
              {t('agentBundle.insecureHttpWarning')}
            </div>
          ) : (
            <div className="inline-flex w-fit items-center gap-2 rounded-full border border-emerald-400/35 bg-emerald-400/10 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              {t('agentBundle.secureTransport')}
            </div>
          )}

          {platform === 'windows' ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 px-4 py-3 text-sm text-[var(--color-fg-muted)]">
              {t('agentBundle.windowsZipNotice')}
            </div>
          ) : null}

          {platform === 'linux' ? (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 px-4 py-3 text-sm text-[var(--color-fg-muted)]">
              {t('agentBundle.linuxNotice')}
            </div>
          ) : null}

          <p className="text-xs text-[var(--color-fg-subtle)]">
            <Link
              to={`/knowledge-base/guide?section=${platform === 'linux' ? 'agent-linux' : 'agent'}`}
              className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline"
            >
              {t('agentBundle.guideLink')}
            </Link>
          </p>

          {showExtended ? (
            <>
              <div>
                <label className="app-label">{t('agentBundle.collectionLevel')}</label>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label
                    className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3 transition ${
                      level === 'full'
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-muted)]'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
                      <input
                        type="radio"
                        name="level"
                        checked={level === 'full'}
                        onChange={() => setLevel('full')}
                      />
                      {t('agentBundle.levelFull')}
                    </span>
                    <span className="mt-1 pl-6 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                      {t('agentBundle.levelFullHint')}
                    </span>
                  </label>
                  <label
                    className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3 transition ${
                      level === 'custom'
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary-muted)]'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-fg)]">
                      <input
                        type="radio"
                        name="level"
                        checked={level === 'custom'}
                        onChange={() => setLevel('custom')}
                      />
                      {t('agentBundle.levelCustom')}
                    </span>
                    <span className="mt-1 pl-6 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                      {t('agentBundle.levelCustomHint')}
                    </span>
                  </label>
                </div>
              </div>

              {showModules ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4">
                  <div className="mb-2 text-[13px] font-semibold text-[var(--color-fg-muted)]">
                    {t('agentBundle.modulesTitle')}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {moduleList.map((key) => (
                      <label key={key} className="flex cursor-pointer items-start gap-2 text-sm text-[var(--color-fg)]">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={Boolean(modules[key])}
                          onChange={() => toggleModule(key)}
                        />
                        <span>{t(`agentBundle.modules.${key}` as const)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 p-4">
            <div className="text-sm font-semibold text-[var(--color-fg)]">{t('agentBundle.tokenTitle')}</div>
            {platform === 'linux' ? (
              <>
                <div className="mt-2 space-y-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  <p>
                    <strong>{t('agentBundle.tokenNewEachBuild')}</strong> {t('agentBundle.tokenIntroBefore')}{' '}
                    <code className="text-[11px]">public_id.secret</code> {t('agentBundle.tokenIntroMiddle')}{' '}
                    <Link to="/settings/agent-tokens" className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline">
                      {t('agentBundle.tokenIntroLink')}
                    </Link>
                    ) {t('agentBundle.tokenIntroAfter')}
                  </p>
                  <p>{t('agentBundle.tokenParagraph2')}</p>
                  <p>{t('agentBundle.tokenParagraph3')}</p>
                </div>
                <div className="mt-3">
                  <label className="app-label">{t('agentBundle.tokenLabelAdmin')}</label>
                  <input className="app-input" value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} />
                </div>
              </>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                {t('agentBundle.windowsZipNotice')}{' '}
                <Link to="/settings/agent-tokens" className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline">
                  {t('agentBundle.tokenIntroLink')}
                </Link>
              </p>
            )}
          </div>

          {platform === 'windows' ? (
          <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('agentBundle.fleetTitle')}</h2>
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('agentBundle.fleetHint')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="app-label">{t('agentBundle.fleetMode')}</label>
                <select
                  className="app-input"
                  value={fleetMode}
                  onChange={(e) => setFleetMode(e.target.value as typeof fleetMode)}
                >
                  <option value="on_demand">{t('agentBundle.fleetOnDemand')}</option>
                  <option value="daily">{t('agentBundle.fleetDaily')}</option>
                  <option value="weekly">{t('agentBundle.fleetWeekly')}</option>
                </select>
              </div>
              {fleetMode !== 'on_demand' ? (
                <div>
                  <label className="app-label">{t('agentBundle.scheduleTimeLabel')}</label>
                  <input className="app-input" type="time" value={fleetTime} onChange={(e) => setFleetTime(e.target.value)} />
                </div>
              ) : null}
              {fleetMode === 'weekly' ? (
                <div>
                  <label className="app-label">{t('agentBundle.fleetWeekday')}</label>
                  <select
                    className="app-input"
                    value={fleetWeekday}
                    onChange={(e) => setFleetWeekday(Number(e.target.value))}
                  >
                    <option value={0}>{t('agentBundle.weekdayMon')}</option>
                    <option value={1}>{t('agentBundle.weekdayTue')}</option>
                    <option value={2}>{t('agentBundle.weekdayWed')}</option>
                    <option value={3}>{t('agentBundle.weekdayThu')}</option>
                    <option value={4}>{t('agentBundle.weekdayFri')}</option>
                    <option value={5}>{t('agentBundle.weekdaySat')}</option>
                    <option value={6}>{t('agentBundle.weekdaySun')}</option>
                  </select>
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="app-btn"
                disabled={fleetBusy}
                onClick={() => {
                  setFleetBusy(true)
                  void api
                    .saveAgentCollectPolicy({
                      mode: fleetMode,
                      time_hhmm: fleetTime,
                      weekday: fleetWeekday,
                      timezone: 'Europe/Moscow',
                      poll_minutes: 5,
                    })
                    .then(() => toast.ok(t('agentBundle.fleetSaved')))
                    .catch((ex) => toast.error(ex instanceof Error ? ex.message : String(ex)))
                    .finally(() => setFleetBusy(false))
                }}
              >
                {t('agentBundle.fleetSave')}
              </button>
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={fleetBusy}
                onClick={() => {
                  setFleetBusy(true)
                  void api
                    .collectAgentsNow()
                    .then(() => toast.ok(t('agentBundle.fleetQueued')))
                    .catch((ex) => toast.error(ex instanceof Error ? ex.message : String(ex)))
                    .finally(() => setFleetBusy(false))
                }}
              >
                {t('agentBundle.fleetCollect')}
              </button>
            </div>
          </div>
          ) : null}

          {platform === 'linux' ? (
          <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
            <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
              {t('agentBundle.auditInterval')}
              <select
                className="app-input app-select"
                value={auditIntervalSec}
                onChange={(event) => setAuditIntervalSec(Number(event.target.value))}
              >
                {[0, 15, 30, 60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400].map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds <= 0
                      ? t('serverAudit.manual')
                      : seconds < 60
                        ? t('serverAudit.everySec', { n: seconds })
                        : t('serverAudit.every', { n: Math.round(seconds / 60) })}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('agentBundle.auditIntervalHint')}</p>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              {t('agentBundle.scheduleEnable')}
            </label>
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {platform === 'linux' ? t('agentBundle.deployStep3Linux') : t('agentBundle.scheduleHint')}
            </p>
            {scheduleEnabled ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="app-label">{t('agentBundle.scheduleModeLabel')}</label>
                  <select
                    className="app-input"
                    value={scheduleMode}
                    onChange={(e) => setScheduleMode(e.target.value as typeof scheduleMode)}
                  >
                    <option value="DAILY">{t('agentBundle.scheduleDaily')}</option>
                    <option value="WEEKLY">{t('agentBundle.scheduleWeekly')}</option>
                    <option value="MONTHLY">{t('agentBundle.scheduleMonthly')}</option>
                  </select>
                </div>
                <div>
                  <label className="app-label">{t('agentBundle.scheduleTimeLabel')}</label>
                  <input
                    className="app-input"
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
          <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] space-y-4 p-5">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">
              {t('agentBundle.buildTitle')}
            </h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summaryServer')}</dt>
                <dd className="max-w-[58%] truncate text-right font-mono text-xs text-[var(--color-fg)]" title={serverUrl}>
                  {serverUrl}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summaryPlatform')}</dt>
                <dd className="text-right font-medium text-[var(--color-fg)]">
                  {platform === 'linux' ? t('agentBundle.platformLinux') : t('agentBundle.platformWin10')}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summaryFormat')}</dt>
                <dd className="text-right font-medium text-[var(--color-fg)]">
                  {platform === 'linux' ? 'ZIP' : 'EXE'}
                </dd>
              </div>
              {showExtended ? (
                <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                  <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summaryLevel')}</dt>
                  <dd className="text-right font-medium text-[var(--color-fg)]">
                    {level === 'full' ? t('agentBundle.levelFull') : t('agentBundle.levelCustom')}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summaryToken')}</dt>
                <dd className="text-right text-[var(--color-fg)]">
                  {t('agentBundle.summaryTokenValue')}
                </dd>
              </div>
              {showModules ? (
                <div className="flex justify-between gap-3 border-b border-[var(--color-border)] pb-2">
                  <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summaryModules')}</dt>
                  <dd className="text-right text-[var(--color-fg)]">{enabledModuleCount}</dd>
                </div>
              ) : null}
              {platform === 'windows' || platform === 'linux' ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-[var(--color-fg-muted)]">{t('agentBundle.summarySchedule')}</dt>
                  <dd className="text-right text-[var(--color-fg)]">
                    {platform === 'windows'
                      ? fleetMode === 'daily'
                        ? t('agentBundle.fleetDaily')
                        : fleetMode === 'weekly'
                          ? t('agentBundle.fleetWeekly')
                          : t('agentBundle.fleetOnDemand')
                      : auditIntervalSec <= 0
                        ? t('serverAudit.manual')
                        : auditIntervalSec < 60
                          ? t('serverAudit.everySec', { n: auditIntervalSec })
                          : t('serverAudit.every', { n: Math.round(auditIntervalSec / 60) })}
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">
              {platform === 'linux' ? t('agentBundle.summaryArchiveLinux') : t('agentBundle.summaryArchiveWin10')}
            </p>
            <button
              type="submit"
              className="app-btn app-btn-primary w-full"
              disabled={busy || lanLoading || !serverHost.trim()}
            >
              {busy
                ? t('agentBundle.building')
                : platform === 'linux'
                  ? t('agentBundle.downloadZip')
                  : t('agentBundle.downloadExe')}
            </button>
          </div>

          <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)]/70 p-5 text-sm text-[var(--color-fg-muted)]">
            <p className="text-sm font-semibold text-[var(--color-fg)]">
              {t('agentBundle.deploymentTitle')}
            </p>
            {platform === 'linux' ? (
              <div className="mt-3 space-y-3">
                <button
                  type="button"
                  className="app-btn app-btn-primary"
                  disabled={busy || lanLoading || !serverHost.trim()}
                  onClick={() => void onInstallCommand()}
                >
                  {busy ? t('agentBundle.building') : t('agentBundle.installCommand')}
                </button>
                {installCommand ? (
                  <div className="space-y-2">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-fg)]">
                      {installCommand}
                    </pre>
                    <button type="button" className="app-btn app-btn-secondary !min-h-0" onClick={() => void onCopyCommand()}>
                      {t('agentBundle.installCopy')}
                    </button>
                  </div>
                ) : null}
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                    {t('agentBundle.installSshHost')}
                    <input className="app-input" value={sshHost} onChange={(event) => setSshHost(event.target.value)} autoComplete="off" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                    {t('agentBundle.installSshPort')}
                    <input className="app-input" value={sshPort} onChange={(event) => setSshPort(event.target.value)} inputMode="numeric" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                    {t('agentBundle.installSshUser')}
                    <input className="app-input" value={sshUser} onChange={(event) => setSshUser(event.target.value)} autoComplete="off" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                    {t('agentBundle.installSshPassword')}
                    <input
                      className="app-input"
                      type="password"
                      value={sshPassword}
                      onChange={(event) => setSshPassword(event.target.value)}
                      autoComplete="new-password"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void onSshInstall()
                        }
                      }}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={sshBusy || lanLoading || !serverHost.trim() || !sshHost.trim() || !sshPassword}
                  onClick={() => void onSshInstall()}
                >
                  {sshBusy ? t('agentBundle.installSshBusy') : t('agentBundle.installSsh')}
                </button>
                {sshOutput ? (
                  <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-fg)]">
                    {sshOutput}
                  </pre>
                ) : null}
              </div>
            ) : (
            <>
            <div className="mt-3 space-y-3">
              <p className="text-sm leading-relaxed">{t('agentBundle.installWinrmHint')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                  {t('agentBundle.installWinrmHost')}
                  <input className="app-input" value={winHost} placeholder="192.168.1.20" onChange={(event) => setWinHost(event.target.value)} autoComplete="off" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                  {t('agentBundle.installWinrmPort')}
                  <input className="app-input" value={winPort} onChange={(event) => setWinPort(event.target.value)} inputMode="numeric" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                  {t('agentBundle.installWinrmUser')}
                  <input className="app-input" value={winUser} placeholder="CORP\\admin" onChange={(event) => setWinUser(event.target.value)} autoComplete="off" onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }} />
                </label>
                <label className="flex flex-col gap-1 text-sm font-medium text-[var(--color-fg)]">
                  {t('agentBundle.installWinrmPassword')}
                  <input
                    className="app-input"
                    type="password"
                    value={winPassword}
                    onChange={(event) => setWinPassword(event.target.value)}
                    autoComplete="new-password"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void onWinrmInstall()
                      }
                    }}
                  />
                </label>
              </div>
              <button
                type="button"
                className="app-btn app-btn-secondary"
                disabled={winBusy || lanLoading || !serverHost.trim() || !winHost.trim() || !winPassword}
                onClick={() => void onWinrmInstall()}
              >
                {winBusy ? t('agentBundle.installWinrmBusy') : t('agentBundle.installWinrm')}
              </button>
              {winOutput ? (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-fg)]">
                  {winOutput}
                </pre>
              ) : null}
            </div>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm leading-relaxed">
              <li>{t('agentBundle.deployStep1')}</li>
              <li>
                {t('agentBundle.deployStep2Before')}{' '}
                <code className="text-xs">CORAX-Agent.exe</code>
              </li>
              <li>{t('agentBundle.deployStep3Win10')}</li>
              <li>{t('agentBundle.deployStep4')}</li>
            </ol>
            </>
            )}
          </div>
        </div>
      </form>

      <EmployeePortalTabsPanel />
    </div>
  )
}
