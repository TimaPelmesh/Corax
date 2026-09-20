import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_LM_STUDIO_URL,
  DEFAULT_OLLAMA_URL,
  detectProviderFromUrl,
  loadWikiRagLmSettings,
  saveWikiRagLmSettings,
  withProvider,
  WIKIRAG_LM_SETTINGS_KEY,
} from './wikiragLmSettings'

describe('wikiragLmSettings', () => {
  beforeEach(() => {
    localStorage.removeItem(WIKIRAG_LM_SETTINGS_KEY)
  })

  it('detects ollama from port 11434', () => {
    expect(detectProviderFromUrl('http://192.168.1.5:11434/v1')).toBe('ollama')
    expect(detectProviderFromUrl('http://127.0.0.1:1234/v1')).toBe('lm_studio')
  })

  it('switches provider to matching default URL', () => {
    const next = withProvider(
      {
        provider: 'lm_studio',
        baseUrl: DEFAULT_LM_STUDIO_URL,
        model: 'x',
        includeCorax: true,
        responseMode: 'fast',
      },
      'ollama',
    )
    expect(next.provider).toBe('ollama')
    expect(next.baseUrl).toBe(DEFAULT_OLLAMA_URL)
    expect(next.model).toBe('corax-chat')
  })

  it('round-trips settings in localStorage', () => {
    saveWikiRagLmSettings({
      provider: 'ollama',
      baseUrl: 'http://10.0.0.2:11434/v1',
      model: 'llama3.2',
      includeCorax: false,
      responseMode: 'detailed',
    })
    const loaded = loadWikiRagLmSettings()
    expect(loaded.provider).toBe('ollama')
    expect(loaded.baseUrl).toBe('http://10.0.0.2:11434/v1')
    expect(loaded.model).toBe('llama3.2')
    expect(loaded.includeCorax).toBe(false)
    expect(loaded.responseMode).toBe('detailed')
  })

  it('saveWikiRagLmSettings skips identical writes', () => {
    const s = {
      provider: 'ollama' as const,
      baseUrl: DEFAULT_OLLAMA_URL,
      model: 'x',
      includeCorax: true,
      responseMode: 'fast' as const,
    }
    expect(saveWikiRagLmSettings(s)).toBe(true)
    expect(saveWikiRagLmSettings(s)).toBe(false)
  })
})
