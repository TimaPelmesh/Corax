import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Bitrix24Config } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey, IconTicket } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
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

  return (
    <div>
      <PageHeader
        icon={<IconTicket className="h-6 w-6" />}
        title={t('titles.bitrix24')}
        subtitle={t('pages.bitrixSubtitle')}
      />

      {!cfg ? (
        <div className="app-card p-6 text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="app-card space-y-3 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {t('settingsBitrix.handlerTitle')}
            </h2>
            <p className="text-sm text-[var(--color-fg-muted)]">
              {t('settingsBitrix.handlerDescription')}
            </p>
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-[12px] text-[var(--color-fg)]">
              {handlerUrlHint}
            </div>
            <p className="text-xs text-[var(--color-fg-muted)]">
              {t('settingsBitrix.handlerTokenHint')}
            </p>
          </section>

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {t('settingsBitrix.settingsTitle')}
            </h2>

            <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={saving}
                onChange={(e) => void save({ enabled: e.target.checked })}
              />
              {t('settingsBitrix.enableIncoming')}
            </label>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-[var(--color-fg-muted)]">{t('settingsBitrix.secretLabel')}</label>
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                  onClick={() => void save({ incoming_secret: genSecret() })}
                  disabled={saving}
                  title={t('settingsBitrix.generateSecretTitle')}
                >
                  {t('settingsBitrix.generateSecret')}
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  className="app-input font-mono text-[13px]"
                  value={cfg.incoming_secret}
                  onChange={(e) => setCfg({ ...cfg, incoming_secret: e.target.value })}
                  placeholder={t('settingsBitrix.secretPlaceholder')}
                />
                <button
                  type="button"
                  className="app-btn app-btn-secondary shrink-0"
                  disabled={saving}
                  onClick={() => void save({ incoming_secret: cfg.incoming_secret })}
                >
                  <IconKey className="h-4 w-4 text-[var(--color-fg-subtle)]" />
                  {t('settingsBitrix.saveSecret')}
                </button>
              </div>
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                {t('settingsBitrix.secretHelp')}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                  {t('settingsBitrix.defaultCategoryLabel')}
                </label>
                <input
                  className="app-input"
                  value={cfg.default_category}
                  onChange={(e) => setCfg({ ...cfg, default_category: e.target.value })}
                  onBlur={() => void save({ default_category: cfg.default_category })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                  {t('settingsBitrix.defaultPriorityLabel')}
                </label>
                <select
                  className="app-input"
                  value={cfg.default_priority}
                  onChange={(e) => void save({ default_priority: e.target.value })}
                >
                  <option value="low">low</option>
                  <option value="normal">normal</option>
                  <option value="high">high</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="app-btn app-btn-secondary"
                onClick={() => void runTest()}
                disabled={testing || saving}
              >
                {testing ? t('settingsBitrix.testing') : t('settingsBitrix.sendTest')}
              </button>
              <span className="text-xs text-[var(--color-fg-muted)]">{t('settingsBitrix.sendTestHint')}</span>
            </div>
          </section>

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {t('settingsBitrix.webhookTitle')}
            </h2>
            <p className="text-sm text-[var(--color-fg-muted)]">
              {t('settingsBitrix.webhookDescription')}
            </p>

            <div className="space-y-2">
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-[12px] text-[var(--color-fg)]">
                {webhookUrl}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="app-btn app-btn-secondary" onClick={() => void copyWebhook()}>
                  {t('settingsBitrix.copyUrl')}
                </button>
                <button type="button" className="app-btn app-btn-secondary" onClick={() => void load()}>
                  {t('common.refresh')}
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-fg)]">
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                {t('settingsBitrix.sampleJsonTitle')}
              </div>
              <pre className="mt-2 overflow-auto rounded-lg bg-neutral-950 p-3 text-[12px] text-white">
{`{
  "title": "${t('settingsBitrix.sampleRequestTitle')}",
  "text": "${t('settingsBitrix.sampleRequestText')}",
  "requester_name": "${t('settingsBitrix.sampleRequesterName')}",
  "location": "${t('settingsBitrix.sampleLocation')}",
  "priority": "normal",
  "category": "printer",
  "external_id": "b24:message:12345",
  "external_url": "https://your.bitrix24.ru/..."
}`}
              </pre>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

