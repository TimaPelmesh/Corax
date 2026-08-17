import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  type TicketHandlerConfig,
  type TicketHandlerIntakeResult,
  type TicketHandlerPipelineStep,
  type TicketHandlerRun,
  type TicketHandlerStats,
  type WikiRagLmStudioStatus,
} from '../api'
import { useAuth } from '../AuthContext'
import { HandlerOverviewCards } from '../components/ticket-handler/HandlerOverviewCards'
import { useT } from '../i18n/LocaleContext'
import {
  defaultUrlForProvider,
  detectProviderFromUrl,
  loadWikiRagLmSettings,
  type LlmProvider,
} from '../lib/wikiragLmSettings'
import { useToast } from '../ToastContext'

const HandlerStatsCharts = lazy(() =>
  import('../components/ticket-handler/HandlerStatsCharts').then((m) => ({ default: m.HandlerStatsCharts })),
)

type TabId = 'overview' | 'pipeline' | 'settings' | 'sandbox'

function canEditConfig(user: { is_superuser?: boolean; role?: string } | null | undefined) {
  if (!user) return false
  if (user.is_superuser) return true
  return (user.role || '').toLowerCase() === 'editor'
}

function statusTone(status: string) {
  const s = (status || '').toLowerCase()
  if (s === 'created_ticket') return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
  if (s === 'error') return 'bg-red-500/15 text-red-700 dark:text-red-300'
  if (s === 'skipped_ticket') return 'bg-amber-500/15 text-amber-800 dark:text-amber-200'
  return 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
}

const fieldClass =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none focus:border-[var(--color-primary)]'
const btnGhost =
  'rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50'
const btnPrimary =
  'rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white disabled:opacity-50'
const panel = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-5'

export function TicketHandlerPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const editable = canEditConfig(user)

  const [tab, setTab] = useState<TabId>('overview')
  const [cfg, setCfg] = useState<TicketHandlerConfig | null>(null)
  const [stats, setStats] = useState<TicketHandlerStats | null>(null)
  const [runs, setRuns] = useState<TicketHandlerRun[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sandboxText, setSandboxText] = useState('')
  const [sandboxTitle, setSandboxTitle] = useState('')
  const [sandboxHost, setSandboxHost] = useState('')
  const [sandboxBusy, setSandboxBusy] = useState(false)
  const [sandboxResult, setSandboxResult] = useState<TicketHandlerIntakeResult | null>(null)
  const [sandboxLive, setSandboxLive] = useState(false)
  const [lmModels, setLmModels] = useState<string[]>([])
  const [lmStatus, setLmStatus] = useState<WikiRagLmStudioStatus | null>(null)
  const [lmChecking, setLmChecking] = useState(false)
  const cfgRef = useRef(cfg)
  cfgRef.current = cfg

  const intakeUrl = useMemo(() => {
    const fromEnv = (import.meta.env.VITE_API_URL ?? '').trim()
    const base = (fromEnv || `${window.location.protocol}//${window.location.hostname || '127.0.0.1'}:3001`).replace(
      /\/$/,
      '',
    )
    return `${base}/api/v1/ticket-handler/intake`
  }, [])

  const shortcutUrl = useMemo(() => `${window.location.origin}/h#pc=PC-NAME`, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [c, s, r] = await Promise.all([
        api.ticketHandlerConfig(),
        api.ticketHandlerStats(),
        api.ticketHandlerRuns(30),
      ])
      setCfg(c)
      setStats(s)
      setRuns(r)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('ticketHandler.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  async function saveConfig(patch: Partial<TicketHandlerConfig>) {
    if (!cfg || !editable || saving) return
    setSaving(true)
    try {
      const next = await api.updateTicketHandlerConfig(patch)
      setCfg(next)
      toast.ok(t('ticketHandler.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('ticketHandler.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function patchLocal(partial: Partial<TicketHandlerConfig>) {
    setCfg((prev) => (prev ? { ...prev, ...partial } : prev))
  }

  const refreshModels = useCallback(
    async (notify = false) => {
      const current = cfgRef.current
      if (!current) return
      const baseUrl = (current.llm_base_url || '').trim()
      if (!baseUrl) {
        setLmModels([])
        setLmStatus({ ok: false, models: [], detail: 'empty url' })
        return
      }
      setLmChecking(true)
      try {
        const st = await api.wikiRagLmStudioStatus({
          base_url: baseUrl,
          model: current.llm_model || undefined,
        })
        setLmStatus(st)
        const models = st.models ?? []
        setLmModels(models)
        const picked = st.selected_model || (models.length === 1 ? models[0] : '') || ''
        if (picked || models.length) {
          setCfg((s) => {
            if (!s) return s
            if (picked && (!s.llm_model || (models.length === 1 && picked))) {
              if (s.llm_model === picked) return s
              return { ...s, llm_model: picked }
            }
            if (s.llm_model && models.length && !models.includes(s.llm_model)) {
              const alt = models.find((m) => m === s.llm_model || m.includes(s.llm_model) || s.llm_model.includes(m))
              if (alt && alt !== s.llm_model) return { ...s, llm_model: alt }
            }
            return s
          })
        }
        if (notify) {
          if (st.ok) toast.ok(t('ticketHandler.modelsOk', { n: String(models.length) }))
          else toast.error(st.detail || t('settingsLlm.checkFail'))
        }
      } catch (e) {
        setLmStatus({ ok: false, models: [], detail: e instanceof Error ? e.message : 'error' })
        setLmModels([])
        if (notify) toast.error(e instanceof Error ? e.message : t('settingsLlm.checkFail'))
      } finally {
        setLmChecking(false)
      }
    },
    [t, toast],
  )

  useEffect(() => {
    if (!cfg?.llm_base_url) return
    const handle = window.setTimeout(() => {
      void refreshModels(false)
    }, 450)
    return () => window.clearTimeout(handle)
  }, [cfg?.llm_base_url, cfg?.llm_provider, refreshModels])

  function setProvider(provider: LlmProvider) {
    patchLocal({
      llm_provider: provider,
      llm_base_url: defaultUrlForProvider(provider),
      llm_model: '',
    })
    setLmModels([])
    setLmStatus(null)
  }

  function setPipeline(pipeline: TicketHandlerPipelineStep[]) {
    patchLocal({ pipeline })
  }

  async function regenerateSecret() {
    if (!editable || saving) return
    setSaving(true)
    try {
      setCfg(await api.regenerateTicketHandlerSecret())
      toast.ok(t('ticketHandler.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('ticketHandler.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  function importLlmSettings() {
    const lm = loadWikiRagLmSettings()
    patchLocal({
      llm_provider: lm.provider,
      llm_base_url: lm.baseUrl,
      llm_model: lm.model,
      include_corax_knowledge: lm.includeCorax,
    })
    toast.ok(t('ticketHandler.importFromLlmOk'))
    window.setTimeout(() => void refreshModels(false), 0)
  }

  async function copyText(text: string, okKey: 'ticketHandler.secretCopied' | 'ticketHandler.endpointCopied') {
    try {
      await navigator.clipboard.writeText(text)
      toast.ok(t(okKey))
    } catch {
      toast.error(t('common.error'))
    }
  }

  async function runSandbox() {
    if (!editable || sandboxBusy) return
    const host = sandboxHost.trim()
    const title = (sandboxTitle.trim() || sandboxText.trim().slice(0, 80) || 'Тест обработчика').slice(0, 255)
    if (host.length < 1 || title.length < 3) {
      toast.error(t('ticketHandler.sandboxNeedFields'))
      return
    }
    setSandboxBusy(true)
    setSandboxResult(null)
    try {
      const out = await api.ticketHandlerSandbox({
        hostname: host,
        title,
        description: sandboxText,
        dry_run: !sandboxLive,
      })
      setSandboxResult(out)
      if (out.ok) toast.ok(t('ticketHandler.sandboxOk'))
      else toast.error(out.error_detail || t('ticketHandler.sandboxFail'))
      if (!out.dry_run) void loadAll()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('ticketHandler.sandboxFail'))
    } finally {
      setSandboxBusy(false)
    }
  }

  function runStatusLabel(status: string) {
    const s = (status || '').toLowerCase()
    if (s === 'created_ticket') return t('ticketHandler.statusCreated')
    if (s === 'skipped_ticket') return t('ticketHandler.statusSkipped')
    if (s === 'error') return t('ticketHandler.statusError')
    return t('ticketHandler.statusOk')
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'overview', label: t('ticketHandler.tabOverview') },
    { id: 'pipeline', label: t('ticketHandler.tabPipeline') },
    { id: 'settings', label: t('ticketHandler.tabSettings') },
    { id: 'sandbox', label: t('ticketHandler.tabSandbox') },
  ]

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-[var(--color-border)] p-0.5">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  tab === item.id ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-fg-subtle)]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" className={btnGhost} onClick={() => void loadAll()} disabled={loading}>
            {t('ticketHandler.refresh')}
          </button>
        </div>
      </header>

      <HandlerOverviewCards stats={stats} enabled={Boolean(cfg?.enabled)} />

      {loading && !cfg ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
      ) : null}

      {tab === 'overview' ? (
        <div className="flex flex-col gap-4">
          <Suspense
            fallback={
              <div className="h-56 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:h-64 sm:p-5" />
            }
          >
            <HandlerStatsCharts stats={stats} />
          </Suspense>
          <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm">
            <div className="border-b border-[var(--color-border)] px-4 py-3">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('ticketHandler.recentRuns')}</h2>
            </div>
            <table className="min-w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                <tr>
                  <th className="px-3 py-2.5 font-medium">{t('ticketHandler.colTime')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('ticketHandler.colStatus')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('ticketHandler.colHost')}</th>
                  <th className="app-hide-xs px-3 py-2.5 font-medium">{t('ticketHandler.colUser')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('ticketHandler.colLatency')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('ticketHandler.colTicket')}</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-[var(--color-fg-subtle)]">
                      {t('ticketHandler.runsEmpty')}
                    </td>
                  </tr>
                ) : (
                  runs.map((r) => (
                    <tr key={r.id} className="border-b border-[var(--color-border)]/70 hover:bg-[var(--color-bg-muted)]/50">
                      <td className="px-3 py-2.5 tabular-nums text-[var(--color-fg-muted)]">
                        {r.created_at ? new Date(r.created_at).toLocaleString() : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone(r.status)}`}>
                          {runStatusLabel(r.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs">{r.hostname || '—'}</td>
                      <td className="app-hide-xs px-3 py-2.5">{r.requester_name || '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        {r.latency_ms != null ? `${r.latency_ms} ms` : '—'}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{r.service_request_id ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {tab === 'pipeline' && cfg ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          <section className={panel}>
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('ticketHandler.pipelineTitle')}</h2>
            <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t('ticketHandler.pipelineFlowHint')}</p>
            <ol className="mt-4 space-y-3 text-sm">
              <li className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-3 py-2.5">
                <span className="font-semibold text-[var(--color-primary)]">1</span>
                <span>
                  <span className="font-medium">Приём с ярлыка /h</span>
                  <span className="mt-0.5 block text-[var(--color-fg-muted)]">Пользователь отправляет тему и описание</span>
                </span>
              </li>
              <li className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-3 py-2.5">
                <span className="font-semibold text-[var(--color-primary)]">2</span>
                <span>
                  <span className="font-medium">Создание заявки</span>
                  <span className="mt-0.5 block text-[var(--color-fg-muted)]">
                    Сразу в CORAX, пользователю только номер. Категория — быстрые ключевые слова.
                  </span>
                </span>
              </li>
              <li className="flex gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-3 py-2.5">
                <span className="font-semibold text-[var(--color-primary)]">3</span>
                <span>
                  <span className="font-medium">AI в фоне</span>
                  <span className="mt-0.5 block text-[var(--color-fg-muted)]">
                    Уточняет категорию из каталога и предлагает тему для ассистента (без авто-переименования).
                  </span>
                </span>
              </li>
            </ol>
            <label className="mt-5 flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={cfg.pipeline.some((s) => s.id === 'classify' && s.enabled) || cfg.pipeline.some((s) => s.id === 'llm' && s.enabled)}
                disabled={!editable}
                onChange={(e) => {
                  const enabled = e.target.checked
                  const hasClassify = cfg.pipeline.some((s) => s.id === 'classify')
                  const next: TicketHandlerPipelineStep[] = hasClassify
                    ? cfg.pipeline.map((s) =>
                        s.id === 'classify' || s.id === 'llm' ? { ...s, enabled } : s,
                      )
                    : [
                        ...cfg.pipeline.filter((s) => !['rag', 'decide', 'reply', 'llm'].includes(s.id)),
                        { id: 'classify', enabled, label: 'AI: категория и тема', params: {} },
                      ]
                  setPipeline(next)
                }}
              />
              <span>
                <span className="block font-medium">{t('ticketHandler.classifyEnabled')}</span>
                <span className="text-[var(--color-fg-muted)]">{t('ticketHandler.classifyEnabledHint')}</span>
              </span>
            </label>
            {editable ? (
              <div className="mt-4">
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={saving}
                  onClick={() => void saveConfig({ pipeline: cfg.pipeline, auto_create_ticket: true })}
                >
                  {t('ticketHandler.savePipeline')}
                </button>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}

      {tab === 'settings' && cfg ? (
        <div className="mx-auto grid w-full max-w-4xl gap-4">
          <section className={panel}>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={cfg.enabled}
                disabled={!editable}
                onChange={(e) => patchLocal({ enabled: e.target.checked })}
              />
              <span>
                <span className="block font-medium text-[var(--color-fg)]">{t('ticketHandler.enabled')}</span>
                <span className="text-sm text-[var(--color-fg-muted)]">{t('ticketHandler.enabledHint')}</span>
              </span>
            </label>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
                  {t('ticketHandler.processorMode')}
                </label>
                <select
                  className={fieldClass}
                  value={cfg.processor_mode === 'remote' ? 'remote' : 'local'}
                  disabled={!editable}
                  onChange={(e) => patchLocal({ processor_mode: e.target.value })}
                >
                  <option value="local">{t('ticketHandler.modeLocal')}</option>
                  <option value="remote">{t('ticketHandler.modeRemote')}</option>
                </select>
              </div>
              {cfg.processor_mode === 'remote' ? (
                <div>
                  <label className="mb-1 block text-sm font-medium text-[var(--color-fg)]">
                    {t('ticketHandler.remoteUrl')}
                  </label>
                  <input
                    className={fieldClass}
                    value={cfg.remote_base_url}
                    disabled={!editable}
                    onChange={(e) => patchLocal({ remote_base_url: e.target.value })}
                    placeholder="http://192.168.1.10:3001"
                  />
                </div>
              ) : null}
            </div>
          </section>

          <section className={panel}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('ticketHandler.llmSection')}</h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={btnGhost}
                  disabled={lmChecking || !cfg.llm_base_url.trim()}
                  onClick={() => void refreshModels(true)}
                >
                  {lmChecking ? t('settingsLlm.checking') : t('ticketHandler.refreshModels')}
                </button>
                {editable ? (
                  <button type="button" className={btnGhost} onClick={importLlmSettings}>
                    {t('ticketHandler.importFromLlm')}
                  </button>
                ) : null}
              </div>
            </div>

            {lmStatus && !lmStatus.ok ? (
              <div className="app-alert app-alert-muted mb-3">
                <div className="font-medium text-[var(--color-fg)]">{t('settingsLlm.offlineTitle')}</div>
                {lmStatus.detail ? (
                  <p className="mt-0.5 font-mono text-[11px] opacity-80">{lmStatus.detail}</p>
                ) : null}
              </div>
            ) : null}
            {lmStatus?.ok ? (
              <div className="mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100">
                <div className="font-medium">{t('settingsLlm.onlineTitle')}</div>
                <p className="mt-0.5 text-xs opacity-90">
                  {[cfg.llm_model || lmStatus.selected_model, cfg.llm_base_url].filter(Boolean).join(' · ')}
                  {lmModels.length ? ` · ${lmModels.length}` : ''}
                </p>
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">{t('ticketHandler.llmProvider')}</label>
                <select
                  className={fieldClass}
                  value={cfg.llm_provider === 'lm_studio' ? 'lm_studio' : 'ollama'}
                  disabled={!editable}
                  onChange={(e) => setProvider(e.target.value as LlmProvider)}
                >
                  <option value="ollama">Ollama</option>
                  <option value="lm_studio">LM Studio</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('ticketHandler.llmModel')}</label>
                {lmModels.length > 0 ? (
                  <select
                    className={fieldClass}
                    value={cfg.llm_model}
                    disabled={!editable}
                    onChange={(e) => patchLocal({ llm_model: e.target.value })}
                  >
                    {lmModels.length > 1 && !cfg.llm_model ? (
                      <option value="">{t('wikirag.chat.autoModel')}</option>
                    ) : null}
                    {!lmModels.includes(cfg.llm_model) && cfg.llm_model ? (
                      <option value={cfg.llm_model}>{cfg.llm_model}</option>
                    ) : null}
                    {lmModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={fieldClass}
                    value={cfg.llm_model}
                    disabled={!editable}
                    onChange={(e) => patchLocal({ llm_model: e.target.value })}
                    placeholder={lmChecking ? t('settingsLlm.checking') : t('wikirag.chat.loadModelHint')}
                  />
                )}
              </div>
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-sm font-medium">{t('ticketHandler.llmUrl')}</label>
              <input
                className={`${fieldClass} font-mono`}
                value={cfg.llm_base_url}
                disabled={!editable}
                placeholder={
                  cfg.llm_provider === 'ollama'
                    ? 'http://192.168.1.10:11434/v1'
                    : 'http://192.168.1.10:1234/v1'
                }
                onChange={(e) => {
                  const url = e.target.value
                  patchLocal({
                    llm_base_url: url,
                    llm_provider: detectProviderFromUrl(url || cfg.llm_base_url),
                    llm_model: '',
                  })
                }}
                onBlur={() => void refreshModels(false)}
              />
              <p className="mt-1.5 text-xs text-[var(--color-fg-muted)]">{t('ticketHandler.llmUrlHint')}</p>
            </div>
          </section>

          <div className="grid gap-4 sm:grid-cols-1">
            <section className={panel}>
              <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
                {t('ticketHandler.ticketSection')}
              </h3>
              <p className="mb-3 text-sm text-[var(--color-fg-muted)]">{t('ticketHandler.ticketFirstHint')}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('ticketHandler.defaultPriority')}</label>
                  <select
                    className={fieldClass}
                    value={cfg.default_priority || 'normal'}
                    disabled={!editable}
                    onChange={(e) => patchLocal({ default_priority: e.target.value })}
                  >
                    <option value="low">{t('ticketHandler.priorityLow')}</option>
                    <option value="normal">{t('ticketHandler.priorityNormal')}</option>
                    <option value="high">{t('ticketHandler.priorityHigh')}</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('ticketHandler.defaultCategory')}</label>
                  <input
                    className={fieldClass}
                    value={cfg.default_category}
                    disabled={!editable}
                    placeholder={t('ticketHandler.defaultCategoryHint')}
                    onChange={(e) => patchLocal({ default_category: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('ticketHandler.defaultCategoryHint')}</p>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">{t('ticketHandler.defaultStatus')}</label>
                  <input
                    className={fieldClass}
                    value={cfg.default_status}
                    disabled={!editable}
                    onChange={(e) => patchLocal({ default_status: e.target.value })}
                  />
                </div>
              </div>
            </section>
          </div>

          <section className={panel}>
            <label className="mb-1 block text-sm font-medium">{t('ticketHandler.systemPrompt')}</label>
            <textarea
              className={`${fieldClass} min-h-[140px]`}
              value={cfg.system_prompt}
              disabled={!editable}
              onChange={(e) => patchLocal({ system_prompt: e.target.value })}
            />
          </section>

          <section className={panel}>
            <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">{t('ticketHandler.clientSection')}</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">{t('ticketHandler.clientSecret')}</label>
                <div className="flex flex-wrap gap-2">
                  <input className={`${fieldClass} min-w-0 flex-1 font-mono`} value={cfg.client_secret} readOnly />
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => void copyText(cfg.client_secret, 'ticketHandler.secretCopied')}
                  >
                    {t('ticketHandler.copySecret')}
                  </button>
                  {editable ? (
                    <button type="button" className={btnGhost} disabled={saving} onClick={() => void regenerateSecret()}>
                      {t('ticketHandler.regenerateSecret')}
                    </button>
                  ) : null}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('ticketHandler.shortcutHint')}</label>
                <div className="flex flex-wrap gap-2">
                  <input className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} value={shortcutUrl} readOnly />
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => void copyText(shortcutUrl, 'ticketHandler.endpointCopied')}
                  >
                    {t('ticketHandler.copyEndpoint')}
                  </button>
                </div>
                <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('ticketHandler.shortcutHelp')}</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('ticketHandler.intakeHint')}</label>
                <div className="flex flex-wrap gap-2">
                  <input className={`${fieldClass} min-w-0 flex-1 font-mono text-xs`} value={intakeUrl} readOnly />
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={() => void copyText(intakeUrl, 'ticketHandler.endpointCopied')}
                  >
                    {t('ticketHandler.copyEndpoint')}
                  </button>
                </div>
              </div>
            </div>
          </section>

          {editable ? (
            <div className="flex justify-end">
              <button
                type="button"
                className={btnPrimary}
                disabled={saving}
                onClick={() =>
                  void saveConfig({
                    enabled: cfg.enabled,
                    processor_mode: cfg.processor_mode,
                    remote_base_url: cfg.remote_base_url,
                    llm_provider: cfg.llm_provider,
                    llm_base_url: cfg.llm_base_url,
                    llm_model: cfg.llm_model,
                    include_corax_knowledge: cfg.include_corax_knowledge,
                    include_wiki_docs: cfg.include_wiki_docs,
                    auto_create_ticket: cfg.auto_create_ticket,
                    default_priority: cfg.default_priority,
                    default_category: cfg.default_category,
                    default_status: cfg.default_status,
                    system_prompt: cfg.system_prompt,
                  })
                }
              >
                {t('ticketHandler.save')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'sandbox' ? (
        <div className={`mx-auto w-full max-w-2xl ${panel}`}>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('ticketHandler.sandboxTitle')}</h2>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t('ticketHandler.sandboxHint')}</p>
          <div className="mt-4 space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium">{t('ticketHandler.sandboxHost')}</label>
              <input
                className={fieldClass}
                value={sandboxHost}
                onChange={(e) => setSandboxHost(e.target.value)}
                placeholder="PC-NAME"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('ticketHandler.sandboxTitleField')}</label>
              <input
                className={fieldClass}
                value={sandboxTitle}
                onChange={(e) => setSandboxTitle(e.target.value)}
                placeholder="Не печатает принтер"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">{t('ticketHandler.sandboxText')}</label>
              <textarea
                className={`${fieldClass} min-h-[140px]`}
                value={sandboxText}
                onChange={(e) => setSandboxText(e.target.value)}
                placeholder="Описание…"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={sandboxLive}
                disabled={!editable}
                onChange={(e) => setSandboxLive(e.target.checked)}
              />
              {t('ticketHandler.sandboxLive')}
            </label>
            <button
              type="button"
              className={btnPrimary}
              disabled={!editable || sandboxBusy}
              onClick={() => void runSandbox()}
            >
              {sandboxBusy ? t('common.loading') : t('ticketHandler.sandboxRun')}
            </button>
          </div>
          {sandboxResult ? (
            <div className="mt-4 space-y-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 p-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${statusTone(sandboxResult.status)}`}>
                  {runStatusLabel(sandboxResult.status)}
                </span>
                {sandboxResult.dry_run ? (
                  <span className="text-xs text-[var(--color-fg-muted)]">{t('ticketHandler.sandboxDry')}</span>
                ) : null}
                {sandboxResult.latency_ms != null ? (
                  <span className="text-xs text-[var(--color-fg-muted)]">{sandboxResult.latency_ms} ms</span>
                ) : null}
              </div>
              {sandboxResult.request_id != null ? (
                <div className="text-[var(--color-fg-muted)]">
                  {t('ticketHandler.colTicket')}: #{sandboxResult.request_id}
                  {sandboxResult.ticket_no != null ? ` / №${sandboxResult.ticket_no}` : ''}
                </div>
              ) : null}
              <p className="whitespace-pre-wrap leading-relaxed text-[var(--color-fg)]">{sandboxResult.answer}</p>
              {sandboxResult.error_detail ? (
                <p className="text-xs text-red-600 dark:text-red-400">{sandboxResult.error_detail}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
