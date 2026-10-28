import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { useToast } from '../../ToastContext'

export function SystemPromptEditor({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const toast = useToast()
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .wikiRagIndexSettings()
      .then((settings) => {
        if (cancelled) return
        setText(settings.system_prompt || settings.system_prompt_default || '')
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function save(next: string) {
    setSaving(true)
    try {
      const saved = await api.updateWikiRagIndexSettings({ system_prompt: next })
      setText(saved.system_prompt || saved.system_prompt_default || '')
      toast.ok(t('settingsLlm.systemPromptSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('wikirag.common.genericError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <label className="block" htmlFor={compact ? 'wikirag-system-prompt' : 'settings-system-prompt'}>
        <span className="app-label">{t('settingsLlm.systemPrompt')}</span>
        <textarea
          id={compact ? 'wikirag-system-prompt' : 'settings-system-prompt'}
          value={text}
          disabled={!loaded || saving}
          maxLength={8000}
          rows={compact ? 5 : 12}
          onChange={(event) => setText(event.target.value)}
          className="app-input mt-1 w-full resize-y font-mono text-xs leading-relaxed"
        />
      </label>
      <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">{t('settingsLlm.systemPromptHint')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!loaded || saving}
          onClick={() => void save(text)}
          className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {t('common.save')}
        </button>
        <button
          type="button"
          disabled={!loaded || saving}
          onClick={() => void save('')}
          className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-fg-muted)] disabled:opacity-50"
        >
          {t('settingsLlm.systemPromptReset')}
        </button>
      </div>
    </div>
  )
}
