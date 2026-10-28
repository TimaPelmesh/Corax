import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Bitrix24Config } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'
import { AppModal } from '../components/ui/AppModal'
import { BitrixBotPanel } from './BitrixBotPanel'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function base64Url(bytes: Uint8Array) {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  const b64 = btoa(s)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function genSecret() {
  const arr = new Uint8Array(24)
  crypto.getRandomValues(arr)
  return base64Url(arr)
}

export function SettingsBitrix24Page() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [cfg, setCfg] = useState<Bitrix24Config | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [incomingOpen, setIncomingOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setCfg(await api.bitrix24Config())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBitrix.loadFailed'))
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const apiBaseGuess = useMemo(() => {
    const fromEnv = (import.meta.env.VITE_API_URL ?? '').trim()
    if (fromEnv) return fromEnv.replace(/\/$/, '')
    const host = window.location.hostname || '127.0.0.1'
    return `http://${host}:3001`
  }, [])

  const webhookUrl = useMemo(() => {
    if (!cfg) return ''
    const url = new URL('/api/v1/integrations/bitrix24/incoming', apiBaseGuess)
    url.searchParams.set('secret', cfg.incoming_secret)
    return url.toString()
  }, [apiBaseGuess, cfg])

  const handlerUrlHint = useMemo(() => {
    const host = window.location.hostname || '127.0.0.1'
    return `http://${host}:3001/handler?token=...`
  }, [])

  async function save(patch: Partial<Bitrix24Config>) {
    if (!cfg) return
    setSaving(true)
    try {
      const next = await api.updateBitrix24Config(patch)
      setCfg(next)
      toast.ok(t('settingsBitrix.saveSuccess'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBitrix.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function copyWebhook() {
    if (!webhookUrl) return
    try {
      await navigator.clipboard.writeText(webhookUrl)
      toast.ok(t('settingsBitrix.copyWebhookSuccess'))
    } catch {
      toast.error(t('settingsBitrix.copyWebhookFailed'))
    }
  }

  async function runTest() {
    setTesting(true)
    try {
      const r = await api.bitrix24IncomingTest({
        title: t('settingsBitrix.testTitle'),
        text: t('settingsBitrix.testText'),
        requester_name: user?.username ?? 'admin',
        category: cfg?.default_category ?? 'bitrix24',
        priority: cfg?.default_priority ?? 'normal',
      })
      toast.ok(t('settingsBitrix.testSuccess', { id: r.request_id }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsBitrix.testFailed'))
    } finally {
      setTesting(false)
    }
  }

  const edge = 'rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50'

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <h1 className="sr-only">{t('titles.bitrix24')}</h1>
      {!cfg ? (
        <div className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</div>
      ) : (
        <BitrixBotPanel
          incomingEnabled={cfg.enabled}
          incomingBusy={saving}
          onIncomingChange={(enabled) => void save({ enabled })}
          onIncomingSettings={() => setIncomingOpen(true)}
        />
      )}
      <AppModal
        open={Boolean(incomingOpen && cfg)}
        onClose={() => setIncomingOpen(false)}
        size="md"
        title={
          <>
            {t('settingsBitrix.incomingOpen')}
            <span className="mt-1 block text-sm font-normal text-[var(--color-fg-subtle)]">
              {t('settingsBitrix.webhookDescription')}
            </span>
          </>
        }
      >
        {cfg ? (
          <div className="space-y-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={cfg.enabled} disabled={saving} onChange={(e) => void save({ enabled: e.target.checked })} />
              {t('settingsBitrix.enableIncoming')}
            </label>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[var(--color-fg-muted)]">{t('settingsBitrix.secretLabel')}</span>
                <button type="button" className="text-xs font-semibold text-[var(--color-fg-muted)]" disabled={saving} title={t('settingsBitrix.generateSecretTitle')} onClick={() => void save({ incoming_secret: genSecret() })}>
                  {t('settingsBitrix.generateSecret')}
                </button>
              </div>
              <div className="flex gap-2">
                <input className="app-input font-mono text-[13px]" value={cfg.incoming_secret} placeholder={t('settingsBitrix.secretPlaceholder')} onChange={(e) => setCfg({ ...cfg, incoming_secret: e.target.value })} />
                <button type="button" className={edge} disabled={saving} onClick={() => void save({ incoming_secret: cfg.incoming_secret })}>
                  <IconKey className="h-4 w-4" />
                </button>
              </div>
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsBitrix.secretHelp')}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs font-medium text-[var(--color-fg-muted)]">
                {t('settingsBitrix.defaultCategoryLabel')}
                <input className="app-input mt-1" value={cfg.default_category} onChange={(e) => setCfg({ ...cfg, default_category: e.target.value })} onBlur={() => void save({ default_category: cfg.default_category })} />
              </label>
              <label className="block text-xs font-medium text-[var(--color-fg-muted)]">
                {t('settingsBitrix.defaultPriorityLabel')}
                <select className="app-input mt-1" value={cfg.default_priority} onChange={(e) => void save({ default_priority: e.target.value })}>
                  <option value="low">low</option>
                  <option value="normal">normal</option>
                  <option value="high">high</option>
                </select>
              </label>
            </div>
            <div>
              <div className="break-all rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 p-3 font-mono text-[12px]">{webhookUrl}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" className={edge} onClick={() => void copyWebhook()}>{t('settingsBitrix.copyUrl')}</button>
                <button type="button" className={edge} disabled={testing || saving} onClick={() => void runTest()}>
                  {testing ? t('settingsBitrix.testing') : t('settingsBitrix.sendTest')}
                </button>
              </div>
            </div>
            <p className="text-xs leading-relaxed text-[var(--color-fg-subtle)]">{handlerUrlHint}. {t('settingsBitrix.handlerTokenHint')}</p>
          </div>
        ) : null}
      </AppModal>
    </div>
  )
}

