import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { api, type AgentBundleProfile, type AgentBundleTarget } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

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

const DEFAULT_PORT = '3001'

function buildServerUrl(host: string, port: string): string {
  const h = host.trim()
  const p = port.trim() || DEFAULT_PORT
  if (!h) return `http://…:${p}`
  return `http://${h}:${p}`
}

export function AgentBundlePage() {
  const t = useT()
  const toast = useToast()
  const { user, loading: authLoading } = useAuth()
  const [serverHost, setServerHost] = useState('')
  const [lanCandidates, setLanCandidates] = useState<string[]>([])
  const [lanLoading, setLanLoading] = useState(true)
  const [serverPort, setServerPort] = useState(DEFAULT_PORT)
  const [platform, setPlatform] = useState<AgentBundleTarget>('cpp')
  const [level, setLevel] = useState<AgentBundleProfile>('full')
  const [tokenLabel, setTokenLabel] = useState('CORAX deploy')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleMode, setScheduleMode] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [modules, setModules] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(MODULE_KEYS.map((k) => [k, true])),
  )
  const [busy, setBusy] = useState(false)

  const serverUrl = useMemo(() => buildServerUrl(serverHost, serverPort), [serverHost, serverPort])

  useEffect(() => {
    if (authLoading || !user?.is_superuser) return
    let cancelled = false
    setLanLoading(true)
    void api
      .agentBundleLanIp()
      .then((r) => {
        if (cancelled) return
        const candidates = r.candidates ?? []
        setLanCandidates(candidates)
        const ip = r.ip ?? candidates[0] ?? ''
        if (ip) setServerHost(ip)
      })
      .catch((ex) => {
        if (cancelled) return
        toast.error(ex instanceof Error ? ex.message : t('agentBundle.lanDetectFailed'))
      })
      .finally(() => {
        if (!cancelled) setLanLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, t, toast, user?.is_superuser])

  const showModules = (platform === 'win10' || platform === 'cpp') && level === 'custom'
  const showExtended = platform === 'win10' || platform === 'cpp'
  const moduleList = useMemo(() => [...MODULE_KEYS], [])
  const enabledModuleCount = useMemo(
    () => Object.values(modules).filter(Boolean).length,
    [modules],
  )

  if (authLoading) {
    return <p className="text-sm text-slate-500">{t('common.loading')}</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  function toggleModule(key: string) {
    setModules((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!serverHost.trim()) {
      toast.error(t('agentBundle.serverHostRequired'))
      return
    }
    setBusy(true)
    try {
      const label =
        tokenLabel.trim() ||
        (platform === 'win7'
          ? t('agentBundle.defaultTokenLabelWin7')
          : platform === 'cpp'
            ? t('agentBundle.defaultTokenLabelCpp')
            : t('agentBundle.defaultTokenLabelWin10'))
      const server = buildServerUrl(serverHost, serverPort)
      const filename = await api.downloadAgentBundle({
            server_url: server,
            target: platform,
            profile: showExtended ? level : 'full',
            create_token: true,
            token_label: label,
            modules: showModules ? modules : undefined,
            schedule:
              platform === 'win10'
                ? {
                    enabled: scheduleEnabled,
                    mode: scheduleMode,
                    time: scheduleTime,
                    weekday: 'MON',
                    task_name: 'CORAX-Agent',
                  }
                : { enabled: false },
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
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconKey className="h-7 w-7 text-blue-600" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.agentBundle')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            {t('pages.agentBundleSubtitle')}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                platform === 'cpp'
                  ? 'bg-neutral-900 text-white'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
              }`}
              onClick={() => setPlatform('cpp')}
            >
              {t('agentBundle.platformCpp')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                platform === 'win10'
                  ? 'bg-neutral-900 text-white'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
              }`}
              onClick={() => setPlatform('win10')}
            >
              {t('agentBundle.platformWin10')}
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                platform === 'win7'
                  ? 'bg-neutral-900 text-white'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
              }`}
              onClick={() => setPlatform('win7')}
            >
              {t('agentBundle.platformWin7')}
            </button>
          </div>
        </div>
      </div>

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,22rem)] xl:grid-cols-[minmax(0,1fr)_24rem]"
      >
        <div className="app-card min-w-0 space-y-5 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
            {t('agentBundle.parametersTitle')}
          </h2>

          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
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
              <p className="mt-1 text-xs text-slate-500">
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
                placeholder={DEFAULT_PORT}
                required
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-slate-500">
            {t('agentBundle.agentUrl')} <code className="font-mono">{serverUrl}</code>
          </p>

          {platform === 'win7' ? (
            <div className="rounded-xl border border-amber-200/80 bg-amber-50/60 px-4 py-3 text-sm text-amber-950">
              {t('agentBundle.win7Notice')}
            </div>
          ) : null}

          {showExtended ? (
            <>
              <div>
                <label className="app-label">{t('agentBundle.collectionLevel')}</label>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label
                    className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3 transition ${
                      level === 'full'
                        ? 'border-blue-300 bg-blue-50/50 ring-1 ring-blue-200'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <input
                        type="radio"
                        name="level"
                        checked={level === 'full'}
                        onChange={() => setLevel('full')}
                      />
                      {t('agentBundle.levelFull')}
                    </span>
                    <span className="mt-1 pl-6 text-xs leading-relaxed text-slate-500">
                      {t('agentBundle.levelFullHint')}
                    </span>
                  </label>
                  <label
                    className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3 transition ${
                      level === 'custom'
                        ? 'border-blue-300 bg-blue-50/50 ring-1 ring-blue-200'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <input
                        type="radio"
                        name="level"
                        checked={level === 'custom'}
                        onChange={() => setLevel('custom')}
                      />
                      {t('agentBundle.levelCustom')}
                    </span>
                    <span className="mt-1 pl-6 text-xs leading-relaxed text-slate-500">
                      {t('agentBundle.levelCustomHint')}
                    </span>
                  </label>
                </div>
              </div>

              {showModules ? (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50/80 p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t('agentBundle.modulesTitle')}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {moduleList.map((key) => (
                      <label key={key} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
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

          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <div className="text-sm font-semibold text-slate-900">{t('agentBundle.tokenTitle')}</div>
            <div className="mt-2 space-y-2 text-xs leading-relaxed text-slate-600">
              <p>
                <strong>{t('agentBundle.tokenNewEachBuild')}</strong> {t('agentBundle.tokenIntroBefore')}{' '}
                <code className="text-[11px]">public_id.secret</code> {t('agentBundle.tokenIntroMiddle')}{' '}
                <Link to="/settings/agent-tokens" className="text-blue-700 underline-offset-2 hover:underline">
                  {t('agentBundle.tokenIntroLink')}
                </Link>
                ) {t('agentBundle.tokenIntroAfter')}
              </p>
              <p>
                {t('agentBundle.tokenParagraph2')}
              </p>
              <p>{t('agentBundle.tokenParagraph3')}</p>
            </div>
            <div className="mt-3">
              <label className="app-label">{t('agentBundle.tokenLabelAdmin')}</label>
              <input className="app-input" value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} />
            </div>
          </div>

          {platform === 'win10' ? (
          <div className="space-y-3 rounded-xl border border-neutral-200 p-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              {t('agentBundle.scheduleEnable')}
            </label>
            <p className="text-xs leading-relaxed text-slate-500">
              {t('agentBundle.scheduleHint')}
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
          <div className="app-card space-y-4 p-5 sm:p-6">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('agentBundle.buildTitle')}
            </h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">{t('agentBundle.summaryServer')}</dt>
                <dd className="max-w-[58%] truncate text-right font-mono text-xs text-slate-800" title={serverUrl}>
                  {serverUrl}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">{t('agentBundle.summaryPlatform')}</dt>
                <dd className="text-right font-medium text-slate-800">
                  {platform === 'cpp'
                    ? t('agentBundle.platformCpp')
                    : platform === 'win10'
                      ? t('agentBundle.platformWin10')
                      : t('agentBundle.platformWin7')}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">{t('agentBundle.summaryFormat')}</dt>
                <dd className="text-right font-medium text-slate-800">
                  {platform === 'cpp' ? t('agentBundle.formatCpp') : 'ZIP'}
                </dd>
              </div>
              {showExtended ? (
                <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                  <dt className="text-slate-500">{t('agentBundle.summaryLevel')}</dt>
                  <dd className="text-right font-medium text-slate-800">
                    {level === 'full' ? t('agentBundle.levelFull') : t('agentBundle.levelCustom')}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">{t('agentBundle.summaryToken')}</dt>
                <dd className="text-right text-slate-800">{t('agentBundle.summaryTokenValue')}</dd>
              </div>
              {showModules ? (
                <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                  <dt className="text-slate-500">{t('agentBundle.summaryModules')}</dt>
                  <dd className="text-right text-slate-800">{enabledModuleCount}</dd>
                </div>
              ) : null}
              {platform === 'win10' ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">{t('agentBundle.summarySchedule')}</dt>
                  <dd className="text-right text-slate-800">
                    {scheduleEnabled
                      ? t('agentBundle.summaryScheduleEnabled')
                      : t('agentBundle.summaryScheduleDisabled')}
                  </dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs leading-relaxed text-slate-500">
              {platform === 'cpp' ? (
                <>{t('agentBundle.summaryArchiveCpp')}</>
              ) : platform === 'win10' ? (
                <>{t('agentBundle.summaryArchiveWin10')}</>
              ) : (
                <>{t('agentBundle.summaryArchiveWin7')}</>
              )}
            </p>
            <button
              type="submit"
              className="app-btn app-btn-primary w-full"
              disabled={busy || lanLoading || !serverHost.trim()}
            >
              {busy
                ? t('agentBundle.building')
                : platform === 'cpp'
                  ? t('agentBundle.downloadCpp')
                  : t('agentBundle.downloadZip')}
            </button>
          </div>

          <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/70 p-5 text-sm text-slate-600">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('agentBundle.deploymentTitle')}
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm leading-relaxed">
              <li>{t('agentBundle.deployStep1')}</li>
              <li>
                {platform === 'cpp' ? (
                  <>
                    {t('agentBundle.deployStep2CppBefore')}{' '}
                    <code className="text-xs">CORAX-Agent.exe</code>{' '}
                    {t('agentBundle.deployStep2CppAfter', { serverUrl })}
                  </>
                ) : (
                  <>
                    {t('agentBundle.deployStep2Before')}{' '}
                    <code className="text-xs">
                      {platform === 'win10' ? 'corax_send.bat' : 'inventory_send_win7.bat'}
                    </code>{' '}
                    {t('agentBundle.deployStep2After', { serverUrl })}
                  </>
                )}
              </li>
              {platform === 'cpp' ? (
                <li>{t('agentBundle.deployStep3Cpp')}</li>
              ) : platform === 'win10' ? (
                <li>{t('agentBundle.deployStep3Win10')}</li>
              ) : (
                <li>{t('agentBundle.deployStep3Win7')}</li>
              )}
              <li>{t('agentBundle.deployStep4')}</li>
            </ol>
          </div>
        </div>
      </form>
    </div>
  )
}
