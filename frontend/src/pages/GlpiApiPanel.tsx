import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type GlpiComputerRow,
  type GlpiConfig,
  type GlpiIdentity,
  type GlpiTestResult,
  type GlpiTestTicketResult,
  type GlpiTicketSyncResult,
} from '../api'
import { GlpiDeviceSync } from './GlpiDeviceSync'
import { GlpiTicketTransfer } from './GlpiTicketTransfer'
import { IconKey, IconTicket } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type ApiMode = 'v2' | 'legacy'
type GrantType = 'password' | 'client_credentials'
type AssetExportMode = 'all' | 'selected'

function identityLines(identity: GlpiIdentity | null | undefined, fallbackUser: string) {
  const lines: { label: string; value: string }[] = []
  if (identity?.display_name) lines.push({ label: 'name', value: identity.display_name })
  const login = identity?.username || fallbackUser
  if (login) lines.push({ label: 'login', value: login })
  if (identity?.profile) lines.push({ label: 'profile', value: identity.profile })
  if (identity?.entity) lines.push({ label: 'entity', value: identity.entity })
  if (identity?.user_id != null) lines.push({ label: 'id', value: String(identity.user_id) })
  return lines
}

function Pill({ children, tone = 'muted' }: { children: string; tone?: 'muted' | 'primary' }) {
  return (
    <span
      className={`inline-flex max-w-full items-center rounded-md px-2 py-0.5 text-[11px] font-medium ${
        tone === 'primary'
          ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
          : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
      }`}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}

export function GlpiApiPanel() {
  const t = useT()
  const toast = useToast()
  const [cfg, setCfg] = useState<GlpiConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiMode, setApiMode] = useState<ApiMode>('v2')
  const [grantType, setGrantType] = useState<GrantType>('password')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [appToken, setAppToken] = useState('')
  const [userToken, setUserToken] = useState('')
  const [verifyTls, setVerifyTls] = useState(true)
  const [limit, setLimit] = useState(500)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [sendingTicket, setSendingTicket] = useState(false)
  const [syncing, setSyncing] = useState<'import' | 'export' | 'import-assets' | 'export-assets' | null>(null)
  const [lastTest, setLastTest] = useState<GlpiTestResult | null>(null)
  const [ticketTitle, setTicketTitle] = useState('CORAX — тестовая заявка')
  const [ticketContent, setTicketContent] = useState(
    'Тестовая заявка из панели CORAX. Можно закрыть или удалить в GLPI.',
  )
  const [lastTicket, setLastTicket] = useState<GlpiTestTicketResult | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const connectInit = useRef(false)
  const [assetMode, setAssetMode] = useState<AssetExportMode>('all')
  const [assetSkipSoftware, setAssetSkipSoftware] = useState(false)
  const [assetRows, setAssetRows] = useState<GlpiComputerRow[]>([])
  const [assetPicked, setAssetPicked] = useState<number[]>([])
  const [assetLoading, setAssetLoading] = useState(false)
  const [lastSyncErrors, setLastSyncErrors] = useState<string[]>([])
  const [lastSyncMessage, setLastSyncMessage] = useState('')
  const apply = useCallback((next: GlpiConfig) => {
    setCfg(next)
    setEnabled(Boolean(next.enabled))
    setBaseUrl(next.base_url || '')
    setApiMode(next.api_mode === 'legacy' ? 'legacy' : 'v2')
    setGrantType(next.grant_type === 'client_credentials' ? 'client_credentials' : 'password')
    setClientId(next.client_id || '')
    setUsername(next.username || '')
    setVerifyTls(next.verify_tls !== false)
    setClientSecret('')
    setPassword('')
    setAppToken('')
    setUserToken('')
  }, [])

  const load = useCallback(async () => {
    try {
      apply(await api.glpiConfig())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.loadFailed'))
    }
  }, [apply, t, toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!cfg || connectInit.current) return
    connectInit.current = true
    if (!cfg.base_url) setConnectOpen(true)
  }, [cfg])

  const urlLooksHttp = useMemo(() => {
    const value = baseUrl.trim().toLowerCase()
    return value.startsWith('http://') || (value.length > 0 && !value.startsWith('https://'))
  }, [baseUrl])

  const activeIdentity = lastTest?.identity || lastTicket?.identity || cfg?.identity || null
  const profileLines = identityLines(activeIdentity, username.trim() || cfg?.username || '')

  function patchBody() {
    const body: Parameters<typeof api.updateGlpiConfig>[0] = {
      enabled,
      base_url: baseUrl.trim(),
      api_mode: apiMode,
      grant_type: grantType,
      client_id: clientId.trim(),
      username: username.trim(),
      verify_tls: urlLooksHttp ? false : verifyTls,
    }
    if (clientSecret.trim()) body.client_secret = clientSecret.trim()
    if (password.trim()) body.password = password.trim()
    if (appToken.trim()) body.app_token = appToken.trim()
    if (userToken.trim()) body.user_token = userToken.trim()
    return body
  }

  async function save(quiet = false) {
    setSaving(true)
    try {
      const next = await api.updateGlpiConfig(patchBody())
      apply(next)
      if (!quiet) toast.ok(t('settingsGlpi.saveSuccess'))
      return next
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.saveFailed'))
      return null
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    try {
      const saved = await save(true)
      if (!saved) return
      const result = await api.glpiTest()
      setLastTest(result)
      apply(await api.glpiConfig())
      if (result.ok) toast.ok(result.message || t('settingsGlpi.test'))
      else toast.error(result.message || t('settingsGlpi.testFailed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.testFailed'))
    } finally {
      setTesting(false)
    }
  }

  async function sendTestTicket() {
    setSendingTicket(true)
    try {
      const saved = await save(true)
      if (!saved) return
      if (!saved.enabled) {
        toast.error(t('settingsGlpi.enabledRequired'))
        return
      }
      const result = await api.glpiTestTicket({
        title: ticketTitle.trim() || undefined,
        content: ticketContent.trim() || undefined,
      })
      setLastTicket(result)
      if (result.identity) {
        setLastTest((prev) =>
          prev
            ? { ...prev, identity: result.identity, ok: true, message: result.message }
            : {
                ok: true,
                message: result.message,
                identity: result.identity,
                version: result.version,
                api_mode: result.api_mode,
              },
        )
      }
      apply(await api.glpiConfig())
      if (result.ok) toast.ok(result.message || t('settingsGlpi.testTicketOk'))
      else toast.error(result.message || t('settingsGlpi.testTicketFailed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.testTicketFailed'))
    } finally {
      setSendingTicket(false)
    }
  }

  function reportSync(kind: 'import' | 'export' | 'import-assets' | 'export-assets', result: GlpiTicketSyncResult) {
    const text =
      kind === 'import'
        ? t('settingsGlpi.importApiDone', {
            created: result.created,
            updated: result.updated,
            skipped: result.skipped,
            failed: result.failed,
          })
        : kind === 'export'
          ? t('settingsGlpi.exportApiDone', {
              created: result.created,
              updated: result.updated,
              failed: result.failed,
            })
          : kind === 'import-assets'
            ? t('settingsGlpi.importAssetsDone', {
                created: result.created,
                updated: result.updated,
                skipped: result.skipped,
                failed: result.failed,
              })
            : t('settingsGlpi.exportAssetsDone', {
                created: result.created,
                updated: result.updated,
                failed: result.failed,
              })
    const errors = result.errors || []
    setLastSyncMessage(result.message || text)
    setLastSyncErrors(errors)
    const detail = errors[0]
    if (result.failed > 0 && result.created + result.updated === 0) {
      toast.error(detail ? `${text}. ${detail}` : text)
      return
    }
    if (result.failed > 0 && detail) toast.error(`${text}. ${detail}`)
    else toast.ok(text)
  }

  async function loadAssetPicker() {
    setAssetLoading(true)
    try {
      const list = await api.glpiLocalComputers(Math.min(2000, Math.max(1, Math.round(limit) || 200)))
      setAssetRows(list)
      setAssetPicked([])
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setAssetLoading(false)
    }
  }

  function toggleAssetPick(id: number) {
    setAssetPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  async function runSync(kind: 'import-assets' | 'export-assets') {
    setSyncing(kind)
    try {
      const saved = await save(true)
      if (!saved) return
      const bounded = Math.min(2000, Math.max(1, Math.round(limit) || 200))
      if (kind === 'export-assets' && assetMode === 'selected' && assetPicked.length === 0) {
        toast.error(t('settingsGlpi.assetsIdsRequired'))
        return
      }
      const result =
        kind === 'import-assets'
          ? await api.glpiImportAssets(bounded)
          : await api.glpiExportAssets(bounded, {
              mode: assetMode,
              computer_ids: assetMode === 'selected' ? assetPicked : undefined,
              skip_software: assetSkipSoftware,
            })
      reportSync(kind, result)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setSyncing(null)
    }
  }

  if (!cfg) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-fg-muted)]">
        {t('common.loading')}
      </section>
    )
  }

  const busy = saving || testing || sendingTicket || syncing !== null
  const connectedOk = Boolean(lastTest?.ok ?? cfg.last_test_ok)
  const canSendTicket = enabled && Boolean(baseUrl.trim()) && !busy

  return (
    <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
          <IconKey className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.apiTitle')}</h2>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            {baseUrl.trim() || t('settingsGlpi.baseUrlHint')}
            {connectedOk ? ` · ${t('settingsGlpi.profileConnected')}` : ''}
          </p>
        </div>
        <button
          type="button"
          className="app-btn app-btn-secondary shrink-0"
          onClick={() => setConnectOpen((open) => !open)}
        >
          {connectOpen ? '▾' : '▸'} {t('settingsGlpi.connectToggle')}
        </button>
      </div>

      {connectOpen ? (
      <>
      <div className="space-y-4 rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.stepConnect')}</h3>
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t('settingsGlpi.enabled')}
          </label>
        </div>

        <p className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          {t('settingsGlpi.apiHttpHint')}
        </p>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm md:col-span-2">
            <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.baseUrl')}</span>
            <input
              className="app-input w-full"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://192.168.1.20/glpi"
              autoComplete="off"
            />
            <span className="mt-1 block text-[11px] text-[var(--color-fg-subtle)]">{t('settingsGlpi.baseUrlHint')}</span>
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.apiMode')}</span>
            <select className="app-input w-full" value={apiMode} onChange={(e) => setApiMode(e.target.value as ApiMode)}>
              <option value="v2">{t('settingsGlpi.apiModeV2')}</option>
              <option value="legacy">{t('settingsGlpi.apiModeLegacy')}</option>
            </select>
          </label>

          {apiMode === 'v2' ? (
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.grantType')}</span>
              <select
                className="app-input w-full"
                value={grantType}
                onChange={(e) => setGrantType(e.target.value as GrantType)}
              >
                <option value="password">{t('settingsGlpi.grantPassword')}</option>
                <option value="client_credentials">{t('settingsGlpi.grantClient')}</option>
              </select>
            </label>
          ) : (
            <div />
          )}
        </div>

        {apiMode === 'v2' ? (
          <div className="grid gap-3 md:grid-cols-2">
            <p className="text-xs text-[var(--color-fg-muted)] md:col-span-2">{t('settingsGlpi.v2Hint')}</p>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.clientId')}</span>
              <input
                className="app-input w-full font-mono text-[13px]"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.clientSecret')}</span>
              <input
                type="password"
                className="app-input w-full font-mono text-[13px]"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                placeholder={cfg.client_secret_set ? t('settingsGlpi.clientSecretSet') : ''}
                autoComplete="new-password"
              />
            </label>
            {grantType === 'password' ? (
              <>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.username')}</span>
                  <input
                    className="app-input w-full"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.password')}</span>
                  <input
                    type="password"
                    className="app-input w-full"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={cfg.password_set ? t('settingsGlpi.passwordSet') : ''}
                    autoComplete="new-password"
                  />
                </label>
              </>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <p className="text-xs text-[var(--color-fg-muted)] md:col-span-2">{t('settingsGlpi.legacyHint')}</p>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.appToken')}</span>
              <input
                type="password"
                className="app-input w-full font-mono text-[13px]"
                value={appToken}
                onChange={(e) => setAppToken(e.target.value)}
                placeholder={cfg.app_token_set ? t('settingsGlpi.appTokenSet') : ''}
                autoComplete="new-password"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.userToken')}</span>
              <input
                type="password"
                className="app-input w-full font-mono text-[13px]"
                value={userToken}
                onChange={(e) => setUserToken(e.target.value)}
                placeholder={cfg.user_token_set ? t('settingsGlpi.userTokenSet') : ''}
                autoComplete="new-password"
              />
            </label>
          </div>
        )}

        <label className={`flex items-center gap-2 text-sm ${urlLooksHttp ? 'text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]'}`}>
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={urlLooksHttp ? false : verifyTls}
            disabled={urlLooksHttp}
            onChange={(e) => setVerifyTls(e.target.checked)}
          />
          {t('settingsGlpi.verifyTls')}
          {urlLooksHttp ? <span className="text-[11px]">({t('settingsGlpi.verifyTlsHttpNA')})</span> : null}
        </label>

        <div className="flex flex-wrap gap-2">
          <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void save(false)}>
            {saving ? t('settingsGlpi.saving') : t('common.save')}
          </button>
          <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={() => void testConnection()}>
            {testing ? t('settingsGlpi.testing') : t('settingsGlpi.test')}
          </button>
        </div>
      </div>

      <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.profileTitle')}</h3>
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.profileHint')}</p>
          </div>
          <Pill tone={connectedOk ? 'primary' : 'muted'}>
            {connectedOk ? t('settingsGlpi.profileConnected') : t('settingsGlpi.profileUnknown')}
          </Pill>
        </div>

        {profileLines.length ? (
          <div className="flex flex-wrap gap-1.5">
            {profileLines.map((line) => (
              <span
                key={line.label}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)]/70 px-2 py-1"
              >
                <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  {line.label === 'name'
                    ? t('settingsGlpi.profileName')
                    : line.label === 'login'
                      ? t('settingsGlpi.profileLogin')
                      : line.label === 'profile'
                        ? t('settingsGlpi.profileRole')
                        : line.label === 'entity'
                          ? t('settingsGlpi.profileEntity')
                          : t('settingsGlpi.profileUserId')}
                </span>
                <span className="truncate text-[12px] font-medium text-[var(--color-fg)]">{line.value}</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--color-fg-muted)]">{t('settingsGlpi.profileEmpty')}</p>
        )}

        {(lastTest || cfg.last_test_message) && (
          <div className="text-xs text-[var(--color-fg-muted)]">
            <span>{lastTest?.message || cfg.last_test_message}</span>
            {(lastTest?.version || cfg.last_version) ? (
              <span>
                {' '}
                · {t('settingsGlpi.version')}: {lastTest?.version || cfg.last_version}
              </span>
            ) : null}
            {lastTest?.tickets_visible != null ? (
              <span>
                {' '}
                · {t('settingsGlpi.ticketsVisible')}: {lastTest.tickets_visible}
              </span>
            ) : null}
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
            <IconTicket className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.testTicketTitle')}</h3>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.testTicketHint')}</p>
          </div>
        </div>

        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.testTicketSubject')}</span>
          <input className="app-input w-full" value={ticketTitle} onChange={(e) => setTicketTitle(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.testTicketBody')}</span>
          <textarea
            className="app-input min-h-[5rem] w-full resize-y"
            value={ticketContent}
            onChange={(e) => setTicketContent(e.target.value)}
          />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={!canSendTicket}
            onClick={() => void sendTestTicket()}
          >
            {sendingTicket ? t('settingsGlpi.testTicketSending') : t('settingsGlpi.testTicketSend')}
          </button>
          {!enabled ? <span className="text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.enabledRequired')}</span> : null}
        </div>

        {lastTicket?.ok ? (
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2 text-sm text-[var(--color-fg)]">
            <div className="font-medium">{lastTicket.message}</div>
            {lastTicket.glpi_id != null ? (
              <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
                ID: #{lastTicket.glpi_id}
                {lastTicket.url ? (
                  <>
                    {' · '}
                    <a
                      href={lastTicket.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-semibold text-[var(--color-primary)] underline-offset-2 hover:underline"
                    >
                      {t('settingsGlpi.testTicketOpen')}
                    </a>
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      </>
      ) : null}

      <GlpiTicketTransfer enabled={enabled && Boolean(baseUrl.trim())} prepare={async () => Boolean(await save(true))} />

      {lastSyncMessage || lastSyncErrors.length ? (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          {lastSyncMessage ? <p className="font-medium text-[var(--color-fg)]">{lastSyncMessage}</p> : null}
          {lastSyncErrors.length ? (
            <ul className="mt-2 list-disc space-y-1 pl-4">
              {lastSyncErrors.slice(0, 8).map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-[var(--color-border)] pt-3">
        <button
          type="button"
          className="text-left text-sm font-semibold text-[var(--color-fg)] hover:text-[var(--color-primary)]"
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={showAdvanced}
        >
          {showAdvanced ? '▾' : '▸'} {t('settingsGlpi.advancedTitle')}
        </button>
        {showAdvanced ? (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsGlpi.advancedHint')}</p>
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">{t('settingsGlpi.syncLimit')}</span>
                <input
                  type="number"
                  min={1}
                  max={2000}
                  className="app-input w-24"
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </label>
            </div>

            <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-3">
              <div>
                <p className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.assetsBlockTitle')}</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.assetsFlow')}</p>
              </div>
              <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.assetsHint')}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ['all', t('settingsGlpi.assetsModeAll'), t('settingsGlpi.assetsModeAllHint')],
                    ['selected', t('settingsGlpi.assetsModeSelected'), t('settingsGlpi.assetsModeSelectedHint')],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                      assetMode === value
                        ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)]'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    <input
                      type="radio"
                      className="mt-1"
                      checked={assetMode === value}
                      onChange={() => setAssetMode(value)}
                      name="glpi-asset-mode"
                    />
                    <span>
                      <span className="font-medium text-[var(--color-fg)]">{label}</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <label className="flex items-start gap-2 text-sm text-[var(--color-fg)]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={assetSkipSoftware}
                  onChange={(e) => setAssetSkipSoftware(e.target.checked)}
                />
                <span>
                  <span className="font-medium">{t('settingsGlpi.assetsSkipSoftware')}</span>
                  <span className="mt-0.5 block text-[11px] text-[var(--color-fg-muted)]">
                    {t('settingsGlpi.assetsSkipSoftwareHint')}
                  </span>
                </span>
              </label>
              {assetMode === 'selected' ? (
                <div className="space-y-2">
                  <button
                    type="button"
                    className="app-btn app-btn-secondary"
                    disabled={busy || assetLoading}
                    onClick={() => void loadAssetPicker()}
                  >
                    {assetLoading ? t('settingsGlpi.syncing') : t('settingsGlpi.assetsPickLoad')}
                  </button>
                  {assetRows.length ? (
                    <div className="app-scroll max-h-56 overflow-auto rounded-lg border border-[var(--color-border)]">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-[var(--color-surface)]">
                          <tr className="border-b border-[var(--color-border)] text-[var(--color-fg-muted)]">
                            <th className="px-2 py-2">
                              <label className="inline-flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={assetRows.length > 0 && assetPicked.length === assetRows.length}
                                  onChange={() =>
                                    setAssetPicked((cur) =>
                                      cur.length === assetRows.length ? [] : assetRows.map((r) => r.id),
                                    )
                                  }
                                />
                                {t('settingsGlpi.devicesSelectAll')}
                              </label>
                            </th>
                            <th className="px-2 py-2">{t('settingsGlpi.assetsColHost')}</th>
                            <th className="px-2 py-2">{t('settingsGlpi.assetsColIp')}</th>
                            <th className="px-2 py-2">{t('settingsGlpi.assetsColSerial')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {assetRows.map((row) => (
                            <tr key={row.id} className="border-b border-[var(--color-border)]">
                              <td className="px-2 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={assetPicked.includes(row.id)}
                                  onChange={() => toggleAssetPick(row.id)}
                                  aria-label={row.hostname}
                                />
                              </td>
                              <td className="px-2 py-1.5 font-medium text-[var(--color-fg)]">{row.hostname}</td>
                              <td className="px-2 py-1.5 tabular-nums">{row.ip_address || '—'}</td>
                              <td className="px-2 py-1.5">{row.serial_number || '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.assetsPickEmpty')}</p>
                  )}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={busy || !enabled}
                  onClick={() => void runSync('import-assets')}
                >
                  {syncing === 'import-assets' ? t('settingsGlpi.syncing') : t('settingsGlpi.importAssets')}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-primary"
                  disabled={busy || !enabled}
                  onClick={() => void runSync('export-assets')}
                >
                  {syncing === 'export-assets' ? t('settingsGlpi.syncing') : t('settingsGlpi.exportAssets')}
                </button>
              </div>
            </div>

            <GlpiDeviceSync limit={limit} enabled={enabled} />
          </div>
        ) : null}
      </div>
    </section>
  )
}
