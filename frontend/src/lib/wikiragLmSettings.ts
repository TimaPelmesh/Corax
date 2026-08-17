export const WIKIRAG_LM_SETTINGS_KEY = 'inventory-wikirag-lm-v1'
export const DEFAULT_LM_STUDIO_URL = 'http://127.0.0.1:1234/v1'
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434/v1'
export const DEFAULT_OLLAMA_MODEL = 'corax-chat'

export type LlmProvider = 'lm_studio' | 'ollama'

export type WikiRagLmSettings = {
  provider: LlmProvider
  baseUrl: string
  model: string
  includeCorax: boolean
  responseMode: 'fast' | 'detailed'
}

export function defaultUrlForProvider(provider: LlmProvider): string {
  return provider === 'ollama' ? DEFAULT_OLLAMA_URL : DEFAULT_LM_STUDIO_URL
}

export function detectProviderFromUrl(url: string): LlmProvider {
  const low = url.toLowerCase()
  if (low.includes('11434') || low.includes('ollama')) return 'ollama'
  return 'lm_studio'
}

export function wikiRagLmSettingsEqual(a: WikiRagLmSettings, b: WikiRagLmSettings): boolean {
  return (
    a.provider === b.provider &&
    a.baseUrl === b.baseUrl &&
    a.model === b.model &&
    a.includeCorax === b.includeCorax &&
    a.responseMode === b.responseMode
  )
}

export function loadWikiRagLmSettings(): WikiRagLmSettings {
  try {
    const raw = localStorage.getItem(WIKIRAG_LM_SETTINGS_KEY)
    if (!raw) {
      return {
        provider: 'ollama',
        baseUrl: DEFAULT_OLLAMA_URL,
        model: DEFAULT_OLLAMA_MODEL,
        includeCorax: true,
        responseMode: 'detailed',
      }
    }
    const data = JSON.parse(raw) as Partial<WikiRagLmSettings>
    const baseUrl = (data.baseUrl || DEFAULT_LM_STUDIO_URL).trim() || DEFAULT_LM_STUDIO_URL
    const provider: LlmProvider =
      data.provider === 'ollama' || data.provider === 'lm_studio'
        ? data.provider
        : detectProviderFromUrl(baseUrl)
    return {
      provider,
      baseUrl,
      model: (data.model || '').trim(),
      includeCorax: data.includeCorax !== false,
      responseMode: data.responseMode === 'fast' ? 'fast' : 'detailed',
    }
  } catch {
    return {
      provider: 'ollama',
      baseUrl: DEFAULT_OLLAMA_URL,
      model: DEFAULT_OLLAMA_MODEL,
      includeCorax: true,
      responseMode: 'detailed',
    }
  }
}

/** Persist settings. Returns false when nothing changed (no event). */
export function saveWikiRagLmSettings(settings: WikiRagLmSettings): boolean {
  const next = JSON.stringify(settings)
  try {
    if (localStorage.getItem(WIKIRAG_LM_SETTINGS_KEY) === next) return false
  } catch {
    /* continue write */
  }
  localStorage.setItem(WIKIRAG_LM_SETTINGS_KEY, next)
  try {
    window.dispatchEvent(new Event('wikirag-lm-settings'))
  } catch {
    /* ignore */
  }
  return true
}

export function subscribeWikiRagLmSettings(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === WIKIRAG_LM_SETTINGS_KEY || e.key === null) onChange()
  }
  const onLocal = () => onChange()
  window.addEventListener('storage', onStorage)
  window.addEventListener('wikirag-lm-settings', onLocal)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('wikirag-lm-settings', onLocal)
  }
}

/** Switch provider and always point at that provider's local default URL. */
export function withProvider(settings: WikiRagLmSettings, provider: LlmProvider): WikiRagLmSettings {
  return {
    ...settings,
    provider,
    model: provider === 'ollama' ? DEFAULT_OLLAMA_MODEL : '',
    baseUrl: defaultUrlForProvider(provider),
  }
}
