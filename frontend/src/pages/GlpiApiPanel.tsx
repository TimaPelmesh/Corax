import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type GlpiComputerRow,
  type GlpiConfig,
  type GlpiIdentity,
  type GlpiTestResult,
  type GlpiTestTicketResult,
  type GlpiTicketSyncResult,
  type ServiceRequestRow,
} from '../api'
import { GlpiDeviceSync } from './GlpiDeviceSync'
import { IconKey, IconTicket } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

type ApiMode = 'v2' | 'legacy'
type GrantType = 'password' | 'client_credentials'
type TicketExportMode = 'force_create' | 'test_one' | 'selected' | 'linked_only' | 'recent' | 'new_only'
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
  const [limit, setLimit] = useState(50)
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
  const [exportMode, setExportMode] = useState<TicketExportMode>('force_create')
  const [exportIdsText, setExportIdsText] = useState('')
  const [ticketPickRows, setTicketPickRows] = useState<ServiceRequestRow[]>([])
  const [ticketPickLoading, setTicketPickLoading] = useState(false)
  const [ticketPicked, setTicketPicked] = useState<number[]>([])
  const [ticketLinkDrafts, setTicketLinkDrafts] = useState<Record<number, string>>({})
  const [ticketLinksSaving, setTicketLinksSaving] = useState(false)
  const [showTicketLinks, setShowTicketLinks] = useState(false)
  const [showMoreTicketModes, setShowMoreTicketModes] = useState(false)
  const [assetMode, setAssetMode] = useState<AssetExportMode>('all')
  const [assetSkipSoftware, setAssetSkipSoftware] = useState(false)
  const [assetRows, setAssetRows] = useState<GlpiComputerRow[]>([])
  const [assetPicked, setAssetPicked] = useState<number[]>([])
  const [assetLoading, setAssetLoading] = useState(false)
  const [lastSyncErrors, setLastSyncErrors] = useState<string[]>([])
  const [lastSyncMessage, setLastSyncMessage] = useState('')
  const [exportProgress, setExportProgress] = useState<{ done: number; total: number; percent: number; label: string } | null>(
    null,
  )

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

  function parseExportIds(raw: string): number[] {
    return Array.from(
      new Set(
        raw
          .split(/[\s,;]+/)
          .map((part) => Number(part.trim()))
          .filter((n) => Number.isInteger(n) && n > 0),
      ),
    ).slice(0, 2000)
  }

  async function loadTicketPicker() {
    setTicketPickLoading(true)
    try {
      const result = await api.serviceRequests({ limit: Math.min(100, Math.max(1, Math.round(limit) || 50)) })
      setTicketPickRows(result.items)
      const drafts: Record<number, string> = {}
      for (const row of result.items) {
        drafts[row.id] = row.glpi_id != null ? String(row.glpi_id) : ''
      }
      setTicketLinkDrafts(drafts)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.syncFailed'))
    } finally {
      setTicketPickLoading(false)
    }
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

  function toggleTicketPick(id: number) {
    setTicketPicked((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      setExportIdsText(next.join(', '))
      return next
    })
  }

  function toggleAssetPick(id: number) {
    setAssetPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
  }

  function setLinkDraft(requestId: number, value: string) {
    setTicketLinkDrafts((prev) => ({ ...prev, [requestId]: value.replace(/[^\d]/g, '') }))
  }

  function clearPickedLinks() {
    setTicketLinkDrafts((prev) => {
      const next = { ...prev }
      for (const id of ticketPicked.length ? ticketPicked : ticketPickRows.map((r) => r.id)) {
        next[id] = ''
      }
      return next
    })
  }

  async function saveTicketLinks() {
    const sourceIds = ticketPicked.length ? ticketPicked : ticketPickRows.map((r) => r.id)
    if (!sourceIds.length) {
      toast.error(t('settingsGlpi.linksNeedRows'))
      return
    }
    const items: Array<{ request_id: number; glpi_id: number | null }> = []
    for (const id of sourceIds) {
      const row = ticketPickRows.find((r) => r.id === id)
      if (!row) continue
      const raw = (ticketLinkDrafts[id] ?? '').trim()
      const nextId = raw === '' ? null : Number(raw)
      if (raw !== '' && (!Number.isInteger(nextId) || (nextId as number) <= 0)) {
        toast.error(t('settingsGlpi.linksInvalidId', { id }))
        return
      }
      const prev = row.glpi_id ?? null
      if (prev === nextId) continue
      items.push({ request_id: id, glpi_id: nextId })
    }
    if (!items.length) {
      toast.ok(t('settingsGlpi.linksNothingChanged'))
      return
    }
    setTicketLinksSaving(true)
    try {
      const result = await api.glpiPatchTicketLinks(items)
      toast.ok(result.message || t('settingsGlpi.linksSaved'))
      if (result.errors?.length) toast.error(result.errors[0])
      await loadTicketPicker()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.linksSaveFailed'))
    } finally {
      setTicketLinksSaving(false)
    }
  }

  async function runSync(kind: 'import' | 'export' | 'import-assets' | 'export-assets') {
    setSyncing(kind)
    try {
      const saved = await save(true)
      if (!saved) return
      const bounded = Math.min(2000, Math.max(1, Math.round(limit) || 200))
      if (kind === 'export' && exportMode === 'selected') {
        const ids = ticketPicked.length ? ticketPicked : parseExportIds(exportIdsText)
        if (!ids.length) {
          toast.error(t('settingsGlpi.exportIdsRequired'))
          return
        }
      }
      if (kind === 'export-assets' && assetMode === 'selected' && assetPicked.length === 0) {
        toast.error(t('settingsGlpi.assetsIdsRequired'))
        return
      }
      const result =
        kind === 'import'
          ? await api.glpiImportTickets(bounded)
          : kind === 'export'
            ? await api.glpiExportTicketsStream(bounded, {
                mode: exportMode,
                request_ids:
                  exportMode === 'selected'
                    ? ticketPicked.length
                      ? ticketPicked
                      : parseExportIds(exportIdsText)
                    : undefined,
                onProgress: (p) => {
                  const label =
                    p.action === 'created'
                      ? t('settingsGlpi.progressCreated', { id: p.corax_id ?? '—' })
                      : p.action === 'updated'
                        ? t('settingsGlpi.progressUpdated', { id: p.corax_id ?? '—' })
                        : p.action === 'failed'
                          ? t('settingsGlpi.progressFailed', { id: p.corax_id ?? '—' })
                          : t('settingsGlpi.progressWorking')
                  setExportProgress({
                    done: p.done,
                    total: p.total,
                    percent: p.percent,
                    label,
                  })
                },
              })
            : kind === 'import-assets'
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
      setExportProgress(null)
    }
  }

  if (!cfg) {
    return (
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-sm text-[var(--color-fg-muted)]">
        {t('common.loading')}
      </section>
    )
  }

  const busy = saving || testing || sendingTicket || syncing !== null || ticketLinksSaving
  const connectedOk = Boolean(lastTest?.ok ?? cfg.last_test_ok)
  const canSendTicket = enabled && Boolean(baseUrl.trim()) && !busy

  return (
    <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
          <IconKey className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.apiTitle')}</h2>
          <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.apiDescription')}</p>
        </div>
      </div>

      <ol className="grid gap-2 sm:grid-cols-3">
        {[
          { n: '1', title: t('settingsGlpi.stepConnect'), hint: t('settingsGlpi.stepConnectHint') },
          { n: '2', title: t('settingsGlpi.stepProfile'), hint: t('settingsGlpi.stepProfileHint') },
          { n: '3', title: t('settingsGlpi.stepTicket'), hint: t('settingsGlpi.stepTicketHint') },
        ].map((step) => (
          <li
            key={step.n}
            className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-3 py-2.5"
          >
            <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--color-fg)]">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--color-primary)] text-[10px] text-white">
                {step.n}
              </span>
              {step.title}
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{step.hint}</p>
          </li>
        ))}
      </ol>

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

      <div
        className={`rounded-xl border px-4 py-3 ${
          connectedOk
            ? 'border-emerald-500/30 bg-emerald-500/[0.07]'
            : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/40'
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.profileTitle')}</h3>
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.profileHint')}</p>
          </div>
          <span
            className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              connectedOk
                ? 'bg-emerald-500/20 text-emerald-800 dark:text-emerald-200'
                : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
            }`}
          >
            {connectedOk ? t('settingsGlpi.profileConnected') : t('settingsGlpi.profileUnknown')}
          </span>
        </div>

        {profileLines.length ? (
          <dl className="mt-3 grid gap-2 sm:grid-cols-2">
            {profileLines.map((line) => (
              <div key={line.label} className="rounded-lg border border-[var(--color-border)]/70 bg-[var(--color-surface)]/70 px-3 py-2">
                <dt className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                  {line.label === 'name'
                    ? t('settingsGlpi.profileName')
                    : line.label === 'login'
                      ? t('settingsGlpi.profileLogin')
                      : line.label === 'profile'
                        ? t('settingsGlpi.profileRole')
                        : line.label === 'entity'
                          ? t('settingsGlpi.profileEntity')
                          : t('settingsGlpi.profileUserId')}
                </dt>
                <dd className="mt-0.5 truncate text-sm font-semibold text-[var(--color-fg)]">{line.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t('settingsGlpi.profileEmpty')}</p>
        )}

        {(lastTest || cfg.last_test_message) && (
          <div className="mt-3 text-xs text-[var(--color-fg-muted)]">
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

      <div className="space-y-3 rounded-xl border border-amber-500/25 bg-amber-500/[0.05] p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-800 dark:text-amber-200">
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
          <div className="rounded-lg border border-emerald-500/25 bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)]">
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
            <p className="text-xs text-[var(--color-fg-muted)]">{t('settingsGlpi.advancedHint')}</p>

            <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 px-3 py-2">
              <label className="block text-sm">
                <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">
                  {t('settingsGlpi.syncLimit')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={2000}
                  className="app-input w-28"
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
                <span className="mt-1 block text-[11px] text-[var(--color-fg-subtle)]">{t('settingsGlpi.syncLimitHint')}</span>
              </label>
              <p className="max-w-md text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.flowHint')}</p>
            </div>

            <div className="space-y-3 rounded-xl border border-[var(--color-border)] p-3">
              <div>
                <p className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.ticketsBlockTitle')}</p>
                <p className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.ticketsFlow')}</p>
              </div>
              <div className="grid gap-2">
                {(
                  [
                    ['force_create', t('settingsGlpi.exportModeForce'), t('settingsGlpi.exportModeForceHint')],
                    ['test_one', t('settingsGlpi.exportModeTestOne'), t('settingsGlpi.exportModeTestOneHint')],
                    ['selected', t('settingsGlpi.exportModeSelected'), t('settingsGlpi.exportModeSelectedHint')],
                  ] as const
                ).map(([value, label, hint]) => (
                  <label
                    key={value}
                    className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                      exportMode === value
                        ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)]'
                        : 'border-[var(--color-border)]'
                    }`}
                  >
                    <input
                      type="radio"
                      className="mt-1"
                      checked={exportMode === value}
                      onChange={() => setExportMode(value)}
                      name="glpi-export-mode"
                    />
                    <span>
                      <span className="font-medium text-[var(--color-fg)]">{label}</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <button
                type="button"
                className="text-[11px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-primary)]"
                onClick={() => setShowMoreTicketModes((v) => !v)}
              >
                {showMoreTicketModes ? '▾' : '▸'} {t('settingsGlpi.exportModeMore')}
              </button>
              {showMoreTicketModes ? (
                <div className="grid gap-2">
                  {(
                    [
                      ['new_only', t('settingsGlpi.exportModeNew'), t('settingsGlpi.exportModeNewHint')],
                      ['recent', t('settingsGlpi.exportModeRecent'), t('settingsGlpi.exportModeRecentHint')],
                      ['linked_only', t('settingsGlpi.exportModeLinked'), t('settingsGlpi.exportModeLinkedHint')],
                    ] as const
                  ).map(([value, label, hint]) => (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm ${
                        exportMode === value
                          ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)]'
                          : 'border-[var(--color-border)]'
                      }`}
                    >
                      <input
                        type="radio"
                        className="mt-1"
                        checked={exportMode === value}
                        onChange={() => setExportMode(value)}
                        name="glpi-export-mode"
                      />
                      <span>
                        <span className="font-medium text-[var(--color-fg)]">{label}</span>
                        <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}

              {exportMode === 'selected' ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="app-btn app-btn-secondary"
                      disabled={busy || ticketPickLoading}
                      onClick={() => void loadTicketPicker()}
                    >
                      {ticketPickLoading ? t('settingsGlpi.syncing') : t('settingsGlpi.exportPickLoad')}
                    </button>
                  </div>
                  {ticketPickRows.length ? (
                    <div className="app-scroll max-h-40 overflow-auto rounded-lg border border-[var(--color-border)]">
                      <ul className="divide-y divide-[var(--color-border)] text-xs">
                        {ticketPickRows.map((row) => (
                          <li key={row.id} className="flex items-start gap-2 px-2 py-1.5">
                            <input
                              type="checkbox"
                              className="mt-0.5"
                              checked={ticketPicked.includes(row.id)}
                              onChange={() => toggleTicketPick(row.id)}
                            />
                            <div className="min-w-0">
                              <div className="font-medium text-[var(--color-fg)]">
                                #{row.id} · {row.title}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <label className="block text-sm">
                    <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">
                      {t('settingsGlpi.exportIdsLabel')}
                    </span>
                    <input
                      className="app-input w-full font-mono text-[13px]"
                      value={exportIdsText}
                      onChange={(e) => {
                        setExportIdsText(e.target.value)
                        setTicketPicked(parseExportIds(e.target.value))
                      }}
                      placeholder="12, 45, 458"
                    />
                  </label>
                </div>
              ) : null}

              <button
                type="button"
                className="text-[11px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-primary)]"
                onClick={() => setShowTicketLinks((v) => !v)}
              >
                {showTicketLinks ? '▾' : '▸'} {t('settingsGlpi.linksTitle')}
              </button>
              {showTicketLinks ? (
                <div className="space-y-2 rounded-lg border border-dashed border-[var(--color-border)] p-3">
                  <p className="text-[11px] leading-relaxed text-[var(--color-fg-muted)]">{t('settingsGlpi.linksHint')}</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="app-btn app-btn-secondary"
                      disabled={busy || ticketPickLoading}
                      onClick={() => void loadTicketPicker()}
                    >
                      {ticketPickLoading ? t('settingsGlpi.syncing') : t('settingsGlpi.exportPickLoad')}
                    </button>
                    <button
                      type="button"
                      className="app-btn app-btn-secondary"
                      disabled={busy || ticketPickRows.length === 0}
                      onClick={clearPickedLinks}
                    >
                      {t('settingsGlpi.linksClear')}
                    </button>
                    <button
                      type="button"
                      className="app-btn app-btn-primary"
                      disabled={busy || ticketPickRows.length === 0}
                      onClick={() => void saveTicketLinks()}
                    >
                      {ticketLinksSaving ? t('settingsGlpi.saving') : t('settingsGlpi.linksSave')}
                    </button>
                  </div>
                  {ticketPickRows.length ? (
                    <div className="app-scroll max-h-44 overflow-auto rounded-lg border border-[var(--color-border)]">
                      <table className="w-full text-left text-xs">
                        <thead className="sticky top-0 bg-[var(--color-surface)]">
                          <tr className="border-b border-[var(--color-border)] text-[var(--color-fg-muted)]">
                            <th className="px-2 py-2" />
                            <th className="px-2 py-2">{t('settingsGlpi.linksColCorax')}</th>
                            <th className="px-2 py-2">{t('settingsGlpi.linksColTitle')}</th>
                            <th className="px-2 py-2">{t('settingsGlpi.linksColGlpi')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ticketPickRows.map((row) => (
                            <tr key={row.id} className="border-b border-[var(--color-border)]">
                              <td className="px-2 py-1.5">
                                <input
                                  type="checkbox"
                                  checked={ticketPicked.includes(row.id)}
                                  onChange={() => toggleTicketPick(row.id)}
                                />
                              </td>
                              <td className="px-2 py-1.5 tabular-nums">#{row.id}</td>
                              <td className="max-w-[12rem] truncate px-2 py-1.5" title={row.title}>
                                {row.title}
                              </td>
                              <td className="px-2 py-1.5">
                                <input
                                  className="app-input w-24 font-mono text-[12px]"
                                  inputMode="numeric"
                                  placeholder="—"
                                  value={ticketLinkDrafts[row.id] ?? ''}
                                  onChange={(e) => setLinkDraft(row.id, e.target.value)}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="text-[11px] text-[var(--color-fg-muted)]">{t('settingsGlpi.linksEmpty')}</p>
                  )}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={busy || !enabled}
                  onClick={() => void runSync('import')}
                >
                  {syncing === 'import' ? t('settingsGlpi.syncing') : t('settingsGlpi.importApi')}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-primary"
                  disabled={busy || !enabled}
                  onClick={() => void runSync('export')}
                >
                  {syncing === 'export' ? t('settingsGlpi.syncing') : t('settingsGlpi.exportApi')}
                </button>
              </div>
            </div>

            {exportProgress ? (
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                <div className="flex items-center justify-between gap-2 text-xs text-[var(--color-fg-muted)]">
                  <span>{exportProgress.label}</span>
                  <span className="tabular-nums font-semibold text-[var(--color-fg)]">
                    {exportProgress.done}/{exportProgress.total} · {exportProgress.percent}%
                  </span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--color-bg-muted)]">
                  <div
                    className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-200"
                    style={{ width: `${Math.min(100, Math.max(0, exportProgress.percent))}%` }}
                  />
                </div>
              </div>
            ) : null}

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
