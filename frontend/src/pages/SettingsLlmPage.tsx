import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type LlmServerSetting, type WikiRagLmStudioStatus } from '../api'
import { IconActivity, IconClose } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { StatusPill } from '../components/ui/StatusPill'
import { AppModal } from '../components/ui/AppModal'
import { SystemPromptEditor } from '../components/wikirag/SystemPromptEditor'
import { useT } from '../i18n/LocaleContext'
import {
  detectProviderFromUrl,
  loadWikiRagLmSettings,
  sameLmEndpoint,
  saveWikiRagLmSettings,
  subscribeWikiRagLmSettings,
  wikiRagLmSettingsEqual,
  type WikiRagLmSettings,
} from '../lib/wikiragLmSettings'
import { useToast } from '../ToastContext'

const PANEL = 'overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]'
const PAGE_SERVERS = 4

const CTX_PRESETS = [0, 4096, 8192, 16384, 32768] as const

type Probe = { ok: boolean; models: string[]; detail?: string }

function stampServers(rows: LlmServerSetting[]): string {
  return JSON.stringify(
    rows.map((row) => ({ id: row.id, label: row.label.trim(), base_url: row.base_url.trim() })),
  )
}

function freshId(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function providerMark(url: string): string {
  const low = url.toLowerCase()
  if (low.includes('11434') || low.includes('ollama')) return 'Ollama'
  if (low.includes('1234') || low.includes('lmstudio') || low.includes('lm-studio')) return 'LM Studio'
  return 'API'
}

export function SettingsLlmPage() {
  const t = useT()
  const toast = useToast()
  const [settings, setSettings] = useState<WikiRagLmSettings>(() => loadWikiRagLmSettings())
  const [servers, setServers] = useState<LlmServerSetting[]>([])
  const [embedBaseUrl, setEmbedBaseUrl] = useState('')
  const [status, setStatus] = useState<WikiRagLmStudioStatus | null>(null)
  const [probes, setProbes] = useState<Record<string, Probe>>({})
  const [busy, setBusy] = useState<string[]>([])
  const [embedModel, setEmbedModel] = useState('bge-m3')
  const [savingEmbed, setSavingEmbed] = useState(false)
  const [lmContextTokens, setLmContextTokens] = useState(0)
  const [effectiveLmContext, setEffectiveLmContext] = useState(16384)
  const [savingContext, setSavingContext] = useState(false)
  const [serversConfigured, setServersConfigured] = useState(true)
  const [ready, setReady] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<null | 'servers' | 'prompt' | 'setup'>(null)
  const settingsRef = useRef(settings)
  const rowsRef = useRef(servers)
  const embedRef = useRef(embedBaseUrl)
  const savedKey = useRef('[]')
  const seeded = useRef(false)
  settingsRef.current = settings
  rowsRef.current = servers
  embedRef.current = embedBaseUrl

  useEffect(() => {
    return subscribeWikiRagLmSettings(() => {
      const loaded = loadWikiRagLmSettings()
      setSettings((prev) => (wikiRagLmSettingsEqual(prev, loaded) ? prev : loaded))
    })
  }, [])

  useEffect(() => {
    saveWikiRagLmSettings(settings)
  }, [settings])

  useEffect(() => {
    let cancelled = false
    void api
      .wikiRagIndexSettings()
      .then((s) => {
        if (cancelled) return
        const list = s.llm_servers ?? []
        setServers(list)
        setServersConfigured(Boolean(s.llm_servers_configured))
        savedKey.current = stampServers(list)
        setEmbedBaseUrl((s.embed_base_url || '').trim())
        setEmbedModel((s.embed_model || 'bge-m3').trim() || 'bge-m3')
        setLmContextTokens(Number.isFinite(s.lm_context_tokens) ? s.lm_context_tokens : 0)
        setEffectiveLmContext(
          Number.isFinite(s.effective_lm_context_tokens) ? s.effective_lm_context_tokens : 16384,
        )
        setReady(true)
      })
      .catch(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const probe = useCallback(
    async (url: string, opts?: { chat?: boolean; notify?: boolean }) => {
      const target = url.trim()
      if (!target) return
      setBusy((prev) => [...prev.filter((item) => !sameLmEndpoint(item, target)), target])
      try {
        const current = settingsRef.current
        const st = await api.wikiRagLmStudioStatus({
          base_url: target,
          model: opts?.chat ? current.model || undefined : undefined,
        })
        const next: Probe = { ok: Boolean(st.ok), models: st.models ?? [], detail: st.detail || undefined }
        const reported = (st.base_url || target).trim()
        setProbes((prev) => ({ ...prev, [target]: next, [reported]: next }))
        if (opts?.chat) {
          setStatus(st)
          const picked = st.selected_model || (st.models.length === 1 ? st.models[0] : '') || ''
          if (picked) {
            setSettings((s) => {
              if (!sameLmEndpoint(s.baseUrl, target) && !sameLmEndpoint(s.baseUrl, reported)) return s
              if (s.model === picked) return s
              if (!s.model || st.models.length === 1) return { ...s, model: picked }
              if (st.models.length && !st.models.includes(s.model)) {
                const alt = st.models.find((m) => m === s.model || m.includes(s.model) || s.model.includes(m))
                if (alt && alt !== s.model) return { ...s, model: alt }
              }
              return s
            })
          }
        }
        if (opts?.notify) {
          if (st.ok) toast.info(t('settingsLlm.checkOk'))
          else toast.info(st.detail || t('settingsLlm.checkFail'))
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : 'error'
        setProbes((prev) => ({ ...prev, [target]: { ok: false, models: [], detail } }))
        if (opts?.chat) setStatus({ ok: false, models: [], detail })
        if (opts?.notify) toast.info(detail || t('settingsLlm.checkFail'))
      } finally {
        setBusy((prev) => prev.filter((item) => !sameLmEndpoint(item, target)))
      }
    },
    [t, toast],
  )

  useEffect(() => {
    if (!ready) return
    void probe(settingsRef.current.baseUrl, { chat: true })
  }, [probe, ready])

  useEffect(() => {
    if (!ready || !embedBaseUrl) return
    void probe(embedBaseUrl)
  }, [embedBaseUrl, probe, ready])

  const persist = useCallback(
    async (list: LlmServerSetting[], opts?: { quiet?: boolean }) => {
      const readyRows = list
        .filter((row) => row.base_url.trim())
        .map((row) => ({ id: row.id, label: row.label.trim(), base_url: row.base_url.trim() }))
      if (stampServers(readyRows) === savedKey.current) return true
      const previous = rowsRef.current
      try {
        const res = await api.updateWikiRagIndexSettings({ llm_servers: readyRows })
        const saved = res.llm_servers ?? []
        savedKey.current = stampServers(saved)
        setServers((current) => {
          const drafts = current.filter((row) => !row.base_url.trim() && !saved.some((item) => item.id === row.id))
          return [...saved, ...drafts]
        })
        for (const server of saved) {
          const old = previous.find((row) => row.id === server.id)
          if (!old) continue
          if (
            sameLmEndpoint(old.base_url, settingsRef.current.baseUrl) &&
            server.base_url !== settingsRef.current.baseUrl
          ) {
            setSettings((s) => ({
              ...s,
              baseUrl: server.base_url,
              provider: detectProviderFromUrl(server.base_url),
            }))
          }
          if (
            embedRef.current &&
            sameLmEndpoint(old.base_url, embedRef.current) &&
            server.base_url !== embedRef.current
          ) {
            const updated = await api.updateWikiRagIndexSettings({ embed_base_url: server.base_url })
            const nextUrl = (updated.embed_base_url || '').trim()
            embedRef.current = nextUrl
            setEmbedBaseUrl(nextUrl)
          }
        }
        if (!opts?.quiet) toast.ok(t('settingsLlm.serversSaved'))
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
        return false
      }
    },
    [t, toast],
  )

  useEffect(() => {
    if (!ready || seeded.current) return
    seeded.current = true
    if (serversConfigured || servers.length || !settingsRef.current.baseUrl.trim()) return
    void persist(
      [{ id: freshId(), label: t('settingsLlm.chatRole'), base_url: settingsRef.current.baseUrl }],
      { quiet: true },
    )
  }, [persist, ready, servers.length, serversConfigured, t])

  useEffect(() => {
    if (!focusId) return
    document.getElementById(`llm-url-${focusId}`)?.focus()
    setFocusId(null)
  }, [focusId, servers])

  function probeFor(url: string): Probe | undefined {
    return Object.entries(probes).find(([key]) => sameLmEndpoint(key, url))?.[1]
  }

  function isBusy(url: string): boolean {
    return busy.some((item) => sameLmEndpoint(item, url))
  }

  function patchRow(id: string, patch: Partial<LlmServerSetting>) {
    setServers((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)))
  }

  function onRowBlur(event: React.FocusEvent<HTMLLIElement>) {
    const next = event.relatedTarget
    if (next instanceof Node && event.currentTarget.contains(next)) return
    void persist(rowsRef.current)
  }

  function addServer() {
    if (servers.length >= 12) return
    const draft = servers.find((row) => !row.base_url.trim())
    if (servers.length >= PAGE_SERVERS) setDialog('servers')
    if (draft) {
      setFocusId(draft.id)
      return
    }
    const id = freshId()
    setServers((prev) => [...prev, { id, label: '', base_url: '' }])
    setFocusId(id)
  }

  function removeServer(id: string) {
    const previous = rowsRef.current
    const next = previous.filter((row) => row.id !== id)
    setServers(next)
    void persist(next).then((ok) => {
      if (!ok) setServers(previous)
    })
  }

  function chooseChat(id: string) {
    const server = servers.find((row) => row.id === id)
    if (!server) return
    setSettings((s) => ({
      ...s,
      baseUrl: server.base_url,
      provider: detectProviderFromUrl(server.base_url),
      model: sameLmEndpoint(s.baseUrl, server.base_url) ? s.model : '',
    }))
    void probe(server.base_url, { chat: true })
  }

  async function chooseEmbed(id: string) {
    const server = servers.find((row) => row.id === id)
    const url = server?.base_url ?? (id.startsWith('http') ? id : '')
    const previous = embedBaseUrl
    setEmbedBaseUrl(url)
    try {
      const res = await api.updateWikiRagIndexSettings({ embed_base_url: url })
      setEmbedBaseUrl((res.embed_base_url || '').trim())
      toast.ok(t('settingsLlm.embedSaved'))
    } catch (e) {
      setEmbedBaseUrl(previous)
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    }
  }

  async function onSaveEmbedModel(next: string) {
    const cleaned = next.trim() || 'bge-m3'
    setEmbedModel(cleaned)
    setSavingEmbed(true)
    try {
      const res = await api.updateWikiRagIndexSettings({ embed_model: cleaned })
      setEmbedModel((res.embed_model || 'bge-m3').trim() || 'bge-m3')
      toast.ok(t('settingsLlm.embedModelSaved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    } finally {
      setSavingEmbed(false)
    }
  }

  async function onSaveLmContext(next: number) {
    const cleaned = Number.isFinite(next) ? Math.max(0, Math.min(32768, Math.round(next))) : 0
    setLmContextTokens(cleaned)
    setSavingContext(true)
    try {
      const res = await api.updateWikiRagIndexSettings({ lm_context_tokens: cleaned })
      setLmContextTokens(res.lm_context_tokens)
      setEffectiveLmContext(res.effective_lm_context_tokens)
      toast.ok(t('settingsLlm.contextSaved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    } finally {
      setSavingContext(false)
    }
  }

  const chatServer = servers.find((row) => sameLmEndpoint(row.base_url, settings.baseUrl))
  const embedServer = servers.find((row) => embedBaseUrl && sameLmEndpoint(row.base_url, embedBaseUrl))
  const chatModels = probeFor(settings.baseUrl)?.models ?? []
  const embedModels = embedBaseUrl ? (probeFor(embedBaseUrl)?.models ?? []) : []
  const chatOptions = chatModels.includes(settings.model) || !settings.model ? chatModels : [settings.model, ...chatModels]
  const embedOptions = embedModels.includes(embedModel) || !embedModel ? embedModels : [embedModel, ...embedModels]
  const chatBusy = isBusy(settings.baseUrl)

  return (
    <div className="settings-page settings-page--wide">
      <PageHeader
        icon={<IconActivity className="h-6 w-6" />}
        title={t('titles.llm')}
        subtitle={t('pages.llmSubtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {status ? (
              <StatusPill tone={status.ok ? 'success' : 'neutral'}>
                {status.ok ? t('settingsLlm.onlineTitle') : t('settingsLlm.offlineTitle')}
              </StatusPill>
            ) : null}
            <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-1.5" onClick={() => setDialog('prompt')}>
              {t('settingsLlm.promptFold')}
            </button>
            <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-1.5" onClick={() => setDialog('setup')}>
              {t('settingsLlm.setupFold')}
            </button>
            <button
              type="button"
              className="app-btn app-btn-primary !min-h-0 !px-3 !py-1.5"
              disabled={chatBusy || !settings.baseUrl.trim()}
              onClick={() => void probe(settings.baseUrl, { chat: true, notify: true })}
            >
              {chatBusy ? t('settingsLlm.checking') : t('wikirag.chat.checkConnection')}
            </button>
          </div>
        }
      />

      {status && !status.ok && status.detail ? (
        <p className="truncate text-[11px] text-[var(--color-fg-muted)]" title={status.detail}>
          {status.detail}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <section className={`${PANEL} order-2`}>
          <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-3 py-2">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsLlm.servers')}</h2>
            <div className="flex items-center gap-1.5">
              {servers.length > PAGE_SERVERS ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                  onClick={() => setDialog('servers')}
                >
                  {t('settingsLlm.moreServers', { n: servers.length - PAGE_SERVERS })}
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-md border border-[var(--color-border)] px-2 py-1 text-xs font-medium text-[var(--color-fg)] disabled:opacity-40"
                disabled={servers.length >= 12}
                onClick={() => {
                  addServer()
                  setDialog('servers')
                }}
              >
                {t('settingsLlm.addServer')}
              </button>
            </div>
          </div>
          {servers.length ? (
            <ul className="grid gap-1 px-3 py-2 sm:grid-cols-2">
              {servers.slice(0, PAGE_SERVERS).map((row) => {
                const hit = row.base_url.trim() ? probeFor(row.base_url) : undefined
                return (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setDialog('servers')}
                      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-[var(--color-bg-muted)]"
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          hit?.ok ? 'bg-[var(--color-primary)]' : hit ? 'bg-[var(--color-fg-subtle)]' : 'bg-[var(--color-border)]'
                        }`}
                      />
                      <span className="truncate text-xs font-medium text-[var(--color-fg)]">
                        {row.label || providerMark(row.base_url)}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--color-fg-subtle)]">
                        {row.base_url || t('settingsLlm.serverUrlPh')}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="px-3 py-4 text-xs text-[var(--color-fg-subtle)]">{t('settingsLlm.serversEmpty')}</p>
          )}
        </section>

        <div className="order-1 grid gap-3 lg:grid-cols-2">
          <section className={PANEL}>
            <div className="border-b border-[var(--color-border)] px-3 py-2">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]" title={t('settingsLlm.chatSeparate')}>
                {t('settingsLlm.chatRole')}
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3">
              <label className="block min-w-0">
                <span className="app-label">{t('settingsLlm.roleServer')}</span>
                <select
                  id="settings-llm-server"
                  value={chatServer?.id ?? (settings.baseUrl ? '__current' : '')}
                  onChange={(e) => chooseChat(e.target.value)}
                  className="app-input mt-1 !min-h-8 text-xs"
                  disabled={!servers.length}
                >
                  {!chatServer && settings.baseUrl ? (
                    <option value="__current">{settings.baseUrl}</option>
                  ) : null}
                  {servers
                    .filter((row) => row.base_url.trim())
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.label || row.base_url}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="app-label">{t('settingsLlm.chatModel')}</span>
                <select
                  id="settings-llm-model"
                  value={settings.model}
                  onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                  className="app-input mt-1 !min-h-8 text-xs"
                  disabled={!chatOptions.length}
                >
                  {!chatOptions.length ? (
                    <option value="">{t('wikirag.chat.loadModelHint')}</option>
                  ) : (
                    <>
                      {chatOptions.length > 1 && !settings.model ? (
                        <option value="">{t('wikirag.chat.autoModel')}</option>
                      ) : null}
                      {chatOptions.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="app-label" title={t('settingsLlm.contextTokensHint')}>
                  {t('settingsLlm.contextShort')}
                </span>
                <select
                  id="settings-llm-context"
                  value={String(lmContextTokens)}
                  disabled={savingContext}
                  onChange={(e) => void onSaveLmContext(Number(e.target.value))}
                  className="app-input mt-1 !min-h-8 text-xs"
                >
                  {(CTX_PRESETS.includes(lmContextTokens as (typeof CTX_PRESETS)[number])
                    ? CTX_PRESETS
                    : [lmContextTokens, ...CTX_PRESETS]
                  ).map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? t('settingsLlm.contextAuto') : String(n)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="app-label">{t('settingsLlm.responseMode')}</span>
                <select
                  value={settings.responseMode}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, responseMode: e.target.value as 'fast' | 'detailed' }))
                  }
                  className="app-input mt-1 !min-h-8 text-xs"
                >
                  <option value="fast">{t('settingsLlm.responseFast')}</option>
                  <option value="detailed">{t('settingsLlm.responseDetailed')}</option>
                </select>
              </label>
              <label className="col-span-2 inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--color-fg)]">
                <input
                  type="checkbox"
                  checked={settings.includeCorax}
                  onChange={(e) => setSettings((s) => ({ ...s, includeCorax: e.target.checked }))}
                  className="rounded border-[var(--color-border)] text-[var(--color-primary)]"
                />
                {t('wikirag.chat.includeCorax')}
              </label>
              {lmContextTokens === 0 ? (
                <p className="col-span-2 text-[11px] text-[var(--color-fg-muted)]">
                  {t('settingsLlm.contextEffective', { n: effectiveLmContext })}
                </p>
              ) : null}
            </div>
          </section>

          <section className={PANEL}>
            <div className="border-b border-[var(--color-border)] px-3 py-2">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]" title={t('settingsLlm.embedSeparate')}>
                {t('settingsLlm.embedRole')}
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-2 p-3">
              <label className="block min-w-0">
                <span className="app-label">{t('settingsLlm.roleServer')}</span>
                <select
                  id="settings-embed-server"
                  value={embedServer?.id ?? (embedBaseUrl || '')}
                  onChange={(e) => void chooseEmbed(e.target.value)}
                  className="app-input mt-1 !min-h-8 text-xs"
                >
                  <option value="">{t('settingsLlm.embedInherit')}</option>
                  {embedBaseUrl && !embedServer ? <option value={embedBaseUrl}>{embedBaseUrl}</option> : null}
                  {servers
                    .filter((row) => row.base_url.trim())
                    .map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.label || row.base_url}
                      </option>
                    ))}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="app-label">{t('settingsLlm.embedModelShort')}</span>
                <select
                  id="settings-embed-model"
                  value={embedModel}
                  disabled={savingEmbed}
                  onChange={(e) => void onSaveEmbedModel(e.target.value)}
                  className="app-input mt-1 !min-h-8 text-xs"
                >
                  {!embedOptions.length ? (
                    <option value={embedModel || 'bge-m3'}>{embedModel || 'bge-m3'}</option>
                  ) : (
                    embedOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
              </label>
            </div>
          </section>
        </div>
      </div>

      <AppModal
        open={dialog === 'prompt'}
        title={t('settingsLlm.promptFold')}
        onClose={() => setDialog(null)}
        size="lg"
      >
        <SystemPromptEditor compact />
      </AppModal>
      <AppModal
        open={dialog === 'setup'}
        title={t('settingsLlm.setupFold')}
        onClose={() => setDialog(null)}
        size="lg"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold text-[var(--color-fg)]">{t('settingsLlm.ollamaSetupTitle')}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-snug text-[var(--color-fg-muted)]">
              <li>{t('settingsLlm.ollamaStep1')}</li>
              <li>{t('settingsLlm.ollamaStep2')}</li>
              <li>{t('settingsLlm.ollamaStep3')}</li>
              <li>{t('settingsLlm.ollamaStep4')}</li>
              <li>{t('settingsLlm.ollamaStep5')}</li>
            </ol>
            <p className="mt-2 text-[11px] text-[var(--color-fg-subtle)]">{t('settingsLlm.ollamaDockerHint')}</p>
          </div>
          <div>
            <h3 className="text-xs font-semibold text-[var(--color-fg)]">{t('settingsLlm.lmSetupTitle')}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs leading-snug text-[var(--color-fg-muted)]">
              <li>{t('settingsLlm.lmStep1')}</li>
              <li>{t('settingsLlm.lmStep2')}</li>
              <li>{t('settingsLlm.lmStep3')}</li>
            </ol>
          </div>
        </div>
      </AppModal>
      <AppModal
        open={dialog === 'servers'}
        title={t('settingsLlm.servers')}
        onClose={() => setDialog(null)}
        size="lg"
      >
        <ul className="grid gap-2 md:grid-cols-2">
          {servers.map((row) => {
            const hit = row.base_url.trim() ? probeFor(row.base_url) : undefined
            return (
              <li
                key={row.id}
                className="grid grid-cols-[minmax(5.5rem,7rem)_minmax(0,1fr)_auto] items-center gap-1.5"
                onBlur={onRowBlur}
              >
                <input
                  aria-label={t('settingsLlm.serverNamePh')}
                  value={row.label}
                  placeholder={t('settingsLlm.serverNamePh')}
                  onChange={(e) => patchRow(row.id, { label: e.target.value })}
                  className="app-input !min-h-8 text-xs"
                />
                <input
                  id={`llm-url-${row.id}`}
                  aria-label={t('settingsLlm.serverUrlPh')}
                  value={row.base_url}
                  placeholder={t('settingsLlm.serverUrlPh')}
                  onChange={(e) => patchRow(row.id, { base_url: e.target.value })}
                  className="app-input !min-h-8 font-mono text-xs"
                />
                <div className="flex items-center gap-1">
                  <span
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                      hit?.ok ? 'bg-[var(--color-primary)]' : hit ? 'bg-[var(--color-fg-subtle)]' : 'bg-[var(--color-border)]'
                    }`}
                    title={hit?.detail || providerMark(row.base_url)}
                  />
                  <button
                    type="button"
                    title={t('settingsLlm.checkOne')}
                    aria-label={t('settingsLlm.checkOne')}
                    disabled={!row.base_url.trim() || isBusy(row.base_url)}
                    onClick={() =>
                      void probe(row.base_url, {
                        chat: sameLmEndpoint(row.base_url, settings.baseUrl),
                        notify: true,
                      })
                    }
                    className="rounded-md p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] disabled:opacity-40"
                  >
                    <IconActivity className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    title={t('settingsLlm.removeServer')}
                    aria-label={t('settingsLlm.removeServer')}
                    onClick={() => removeServer(row.id)}
                    className="rounded-md p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
                  >
                    <IconClose className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
        {!servers.length ? <p className="text-xs text-[var(--color-fg-subtle)]">{t('settingsLlm.serversEmpty')}</p> : null}
      </AppModal>
    </div>
  )
}
