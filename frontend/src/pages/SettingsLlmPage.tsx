import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type WikiRagLmStudioStatus } from '../api'
import { IconActivity } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import {
  detectProviderFromUrl,
  loadWikiRagLmSettings,
  saveWikiRagLmSettings,
  subscribeWikiRagLmSettings,
  wikiRagLmSettingsEqual,
  withProvider,
  type LlmProvider,
  type WikiRagLmSettings,
} from '../lib/wikiragLmSettings'
import { useToast } from '../ToastContext'

const PANEL = 'rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]'

export function SettingsLlmPage() {
  const t = useT()
  const toast = useToast()
  const [settings, setSettings] = useState<WikiRagLmSettings>(() => loadWikiRagLmSettings())
  const [status, setStatus] = useState<WikiRagLmStudioStatus | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [checking, setChecking] = useState(false)
  const [embedModel, setEmbedModel] = useState('bge-m3')
  const [savingEmbed, setSavingEmbed] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

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
    void api
      .wikiRagIndexSettings()
      .then((s) => setEmbedModel((s.embed_model || 'bge-m3').trim() || 'bge-m3'))
      .catch(() => undefined)
  }, [])

  const check = useCallback(
    async (notify = false) => {
      const current = settingsRef.current
      setChecking(true)
      try {
        const st = await api.wikiRagLmStudioStatus({
          base_url: current.baseUrl,
          model: current.model || undefined,
        })
        setStatus(st)
        setModels(st.models ?? [])
        const picked = st.selected_model || (st.models.length === 1 ? st.models[0] : '') || ''
        if (picked) {
          setSettings((s) => {
            if (s.model === picked) return s
            if (!s.model || (st.models.length === 1 && picked)) return { ...s, model: picked }
            if (st.models.length && !st.models.includes(s.model)) {
              const alt = st.models.find((m) => m === s.model || m.includes(s.model) || s.model.includes(m))
              if (alt && alt !== s.model) return { ...s, model: alt }
            }
            return s
          })
        }
        if (notify) {
          if (st.ok) toast.info(t('settingsLlm.checkOk'))
          else toast.info(st.detail || t('settingsLlm.checkFail'))
        }
      } catch (e) {
        setStatus({ ok: false, models: [], detail: e instanceof Error ? e.message : 'error' })
        if (notify) toast.info(e instanceof Error ? e.message : t('settingsLlm.checkFail'))
      } finally {
        setChecking(false)
      }
    },
    [t, toast],
  )

  useEffect(() => {
    void check(false)
  }, [check, settings.provider, settings.baseUrl])

  function setProvider(provider: LlmProvider) {
    setSettings((s) => withProvider(s, provider))
    setModels([])
    setStatus(null)
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

  const embedOptions = models.includes(embedModel) || !embedModel ? models : [embedModel, ...models]

  const providers = [
    {
      id: 'lm_studio' as const,
      title: t('wikirag.chat.providerLmStudio'),
      hint: t('wikirag.chat.providerLmStudioHint'),
    },
    {
      id: 'ollama' as const,
      title: t('wikirag.chat.providerOllama'),
      hint: t('wikirag.chat.providerOllamaHint'),
    },
  ]

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <PageHeader
        icon={<IconActivity className="h-6 w-6" />}
        title={t('titles.llm')}
        subtitle={t('pages.llmSubtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {status ? (
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                  status.ok
                    ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
                    : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
                }`}
              >
                {status.ok ? t('settingsLlm.onlineTitle') : t('settingsLlm.offlineTitle')}
              </span>
            ) : null}
            <button
              type="button"
              className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              disabled={checking}
              onClick={() => void check(true)}
            >
              {checking ? t('settingsLlm.checking') : t('wikirag.chat.checkConnection')}
            </button>
          </div>
        }
      />

      {status && !status.ok ? (
        <div className="app-alert app-alert-muted">
          <p className="font-medium text-[var(--color-fg)]">{t('settingsLlm.offlineTitle')}</p>
          <p className="mt-1 text-xs leading-relaxed">{t('settingsLlm.offlineBody')}</p>
          {status.detail ? <p className="mt-1 font-mono text-[11px] text-[var(--color-fg-subtle)]">{status.detail}</p> : null}
        </div>
      ) : null}

      {status?.ok ? (
        <div className={`${PANEL} px-4 py-2.5 text-sm text-[var(--color-fg-muted)]`}>
          <span className="font-medium text-[var(--color-fg)]">{t('settingsLlm.onlineTitle')}</span>
          <span className="mx-2 text-[var(--color-fg-subtle)]">·</span>
          {[status.selected_model || settings.model, status.base_url || settings.baseUrl].filter(Boolean).join(' · ')}
        </div>
      ) : null}

      <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsLlm.connection')}</h2>
          <div className="inline-flex rounded-md border border-[var(--color-border)] p-0.5">
            {providers.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setProvider(opt.id)}
                className={`rounded px-2.5 py-1 text-[11px] font-semibold transition ${
                  settings.provider === opt.id
                    ? 'bg-[var(--color-primary)] text-white'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                {opt.title}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
          {providers.find((p) => p.id === settings.provider)?.hint}
        </p>
        <label className="block">
            <span className="app-label">{t('wikirag.chat.lmBaseUrl')}</span>
            <input
              id="settings-llm-url"
              type="text"
              value={settings.baseUrl}
              onChange={(e) =>
                setSettings((s) => ({
                  ...s,
                  model: '',
                  baseUrl: e.target.value,
                  provider: detectProviderFromUrl(e.target.value || s.baseUrl),
                }))
              }
              onBlur={() => void check(false)}
              placeholder={
                settings.provider === 'ollama' ? 'http://192.168.1.10:11434/v1' : 'http://192.168.1.10:1234/v1'
              }
              className="app-input mt-1 !min-h-9 font-mono text-sm"
            />
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">
              {settings.provider === 'ollama' ? t('wikirag.chat.ollamaHelp') : t('wikirag.chat.lmHelp')}
            </p>
          </label>

          <label className="block">
            <span className="app-label">{t('settingsLlm.chatModel')}</span>
            <select
              id="settings-llm-model"
              value={settings.model}
              onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
              className="app-input mt-1 !min-h-9 text-sm"
              disabled={!models.length}
            >
              {!models.length ? (
                <option value="">{t('wikirag.chat.loadModelHint')}</option>
              ) : (
                <>
                  {models.length > 1 && !settings.model ? (
                    <option value="">{t('wikirag.chat.autoModel')}</option>
                  ) : null}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </>
              )}
            </select>
            <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('settingsLlm.chatModelHint')}</p>
          </label>

          <label className="block">
            <span className="app-label">{t('settingsLlm.embedModel')}</span>
            <select
              id="settings-embed-model"
              value={embedModel}
              disabled={savingEmbed}
              onChange={(e) => void onSaveEmbedModel(e.target.value)}
              className="app-input mt-1 !min-h-9 text-sm"
            >
              {!embedOptions.length ? (
                <option value={embedModel || 'bge-m3'}>{embedModel || 'bge-m3'}</option>
              ) : (
                embedOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              )}
            </select>
            <p className="mt-1 text-[11px] text-[var(--color-fg-subtle)]">{t('settingsLlm.embedModelHint')}</p>
          </label>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-0.5">
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={settings.includeCorax}
                onChange={(e) => setSettings((s) => ({ ...s, includeCorax: e.target.checked }))}
                className="rounded border-[var(--color-border)] text-[var(--color-primary)]"
              />
              {t('wikirag.chat.includeCorax')}
            </label>
            <label className="inline-flex items-center gap-2 text-sm text-[var(--color-fg)]">
              {t('settingsLlm.responseMode')}
              <select
                value={settings.responseMode}
                onChange={(e) =>
                  setSettings((s) => ({ ...s, responseMode: e.target.value as 'fast' | 'detailed' }))
                }
                className="app-input !min-h-8 !w-auto !px-2 !py-1 text-xs"
              >
                <option value="fast">{t('settingsLlm.responseFast')}</option>
                <option value="detailed">{t('settingsLlm.responseDetailed')}</option>
              </select>
            </label>
        </div>
      </section>

      <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
          {settings.provider === 'ollama' ? (
            <>
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsLlm.ollamaSetupTitle')}</h2>
              <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-[var(--color-fg-muted)]">
                <li>{t('settingsLlm.ollamaStep1')}</li>
                <li>{t('settingsLlm.ollamaStep2')}</li>
                <li>{t('settingsLlm.ollamaStep3')}</li>
                <li>{t('settingsLlm.ollamaStep4')}</li>
                <li>{t('settingsLlm.ollamaStep5')}</li>
              </ol>
              <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2.5 font-mono text-[11px] text-[var(--color-fg)]">
                <div>ollama pull bge-m3</div>
                <div className="mt-0.5">ollama pull llama3.2</div>
                <div className="mt-0.5">set OLLAMA_HOST=0.0.0.0:11434</div>
                <div className="mt-0.5">ollama serve</div>
              </div>
              <p className="text-[11px] text-[var(--color-fg-subtle)]">{t('settingsLlm.ollamaDockerHint')}</p>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsLlm.lmSetupTitle')}</h2>
              <ol className="list-decimal space-y-1.5 pl-4 text-sm leading-relaxed text-[var(--color-fg-muted)]">
                <li>{t('settingsLlm.lmStep1')}</li>
                <li>{t('settingsLlm.lmStep2')}</li>
                <li>{t('settingsLlm.lmStep3')}</li>
              </ol>
            </>
          )}
        </section>
    </div>
  )
}
