import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type GlpiConfig, type GlpiTestResult, type GlpiTicketSyncResult } from '../api'
import { GlpiDeviceSync } from './GlpiDeviceSync'
import { IconKey, IconTicket } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type ApiMode = 'v2' | 'legacy'
type GrantType = 'password' | 'client_credentials'

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
  const [limit, setLimit] = useState(200)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState<'import' | 'export' | 'import-assets' | 'export-assets' | null>(null)
  const [lastTest, setLastTest] = useState<GlpiTestResult | null>(null)

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

  const urlLooksHttp = useMemo(() => {
    const value = baseUrl.trim().toLowerCase()
    return value.startsWith('http://') || (value.length > 0 && !value.startsWith('https://'))
  }, [baseUrl])

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
    const detail = result.errors?.[0]
    if (result.failed > 0 && result.created + result.updated === 0) {
      toast.error(detail ? `${text}. ${detail}` : text)
      return
    }
    if (result.failed > 0 && detail) toast.error(`${text}. ${detail}`)
    else toast.ok(text)
  }

  async function runSync(kind: 'import' | 'export' | 'import-assets' | 'export-assets') {
    setSyncing(kind)
    try {
      const saved = await save(true)
      if (!saved) return
      const bounded = Math.min(2000, Math.max(1, Math.round(limit) || 200))
      const result =
        kind === 'import'
          ? await api.glpiImportTickets(bounded)
          : kind === 'export'
            ? await api.glpiExportTickets(bounded)
            : kind === 'import-assets'
              ? await api.glpiImportAssets(bounded)
              : await api.glpiExportAssets(bounded)
      reportSync(kind, result)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setSyncing(null)
    }
  }

  if (!cfg) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-fg-muted)] xl:col-span-2">
        {t('common.loading')}
      </section>
    )
  }

  const busy = saving || testing || syncing !== null

  return (
    <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 xl:col-span-2">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
          <IconKey className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.apiTitle')}</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.apiDescription')}</p>
        </div>
      </div>

      <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-3 py-2 text-xs text-[var(--color-fg-muted)]">
        {t('settingsGlpi.apiHttpHint')}
      </p>

      <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        {t('settingsGlpi.enabled')}
      </label>

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
            <input className="app-input w-full font-mono text-[13px]" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" />
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
                <input className="app-input w-full" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
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
        <button type="button" className="app-btn app-btn-primary" disabled={busy} onClick={() => void save(false)}>
          {saving ? t('settingsGlpi.saving') : t('common.save')}
        </button>
        <button type="button" className="app-btn app-btn-secondary" disabled={busy} onClick={() => void testConnection()}>
          {testing ? t('settingsGlpi.testing') : t('settingsGlpi.test')}
        </button>
      </div>

      {lastTest || cfg.last_test_message ? (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            (lastTest?.ok ?? cfg.last_test_ok)
              ? 'border-sky-500/25 bg-sky-500/[0.07] text-[var(--color-fg)]'
              : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 text-[var(--color-fg-muted)]'
          }`}
        >
          <div className="font-medium">{lastTest?.message || cfg.last_test_message}</div>
          <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {(lastTest?.api_mode || cfg.api_mode) ? <span>{lastTest?.api_mode || cfg.api_mode}</span> : null}
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
        </div>
      ) : null}

      <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-end sm:justify-between">
        <label className="block text-sm">
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
            <IconTicket className="h-3.5 w-3.5" />
            {t('settingsGlpi.syncLimit')}
          </span>
          <input
            type="number"
            min={1}
            max={2000}
            className="app-input w-32"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={busy || !enabled}
            onClick={() => void runSync('import')}
          >
            {syncing === 'import' ? t('settingsGlpi.syncing') : t('settingsGlpi.importApi')}
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary"
            disabled={busy || !enabled}
            onClick={() => void runSync('export')}
          >
            {syncing === 'export' ? t('settingsGlpi.syncing') : t('settingsGlpi.exportApi')}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-4">
        <p className="text-xs leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.assetsHint')}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={busy || !enabled}
            onClick={() => void runSync('import-assets')}
          >
            {syncing === 'import-assets' ? t('settingsGlpi.syncing') : t('settingsGlpi.importAssets')}
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary"
            disabled={busy || !enabled}
            onClick={() => void runSync('export-assets')}
          >
            {syncing === 'export-assets' ? t('settingsGlpi.syncing') : t('settingsGlpi.exportAssets')}
          </button>
        </div>
      </div>

      <GlpiDeviceSync limit={limit} enabled={enabled} />
    </section>
  )
}
