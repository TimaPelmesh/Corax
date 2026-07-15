import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Bitrix24Config } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey, IconTicket } from '../components/icons'
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
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconTicket className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.bitrix24')}</h1>
          <p className="mt-1 max-w-3xl text-slate-600">
            {t('pages.bitrixSubtitle')}
          </p>
        </div>
      </div>

      {!cfg ? (
        <div className="app-card p-6 text-sm text-slate-600">{t('common.loading')}</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="app-card space-y-3 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('settingsBitrix.handlerTitle')}
            </h2>
            <p className="text-sm text-slate-600">
              {t('settingsBitrix.handlerDescription')}
            </p>
            <div className="rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 font-mono text-[12px] text-slate-800">
              {handlerUrlHint}
            </div>
            <p className="text-xs text-slate-500">
              {t('settingsBitrix.handlerTokenHint')}
            </p>
          </section>

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('settingsBitrix.settingsTitle')}
            </h2>

            <label className="flex items-center gap-2 text-sm text-slate-700">
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
                <label className="text-xs font-medium text-slate-600">{t('settingsBitrix.secretLabel')}</label>
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
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
                  <IconKey className="h-4 w-4 text-neutral-400" />
                  {t('settingsBitrix.saveSecret')}
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {t('settingsBitrix.secretHelp')}
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">
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
                <label className="mb-1 block text-xs font-medium text-slate-600">
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
              <span className="text-xs text-slate-500">{t('settingsBitrix.sendTestHint')}</span>
            </div>
          </section>

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
              {t('settingsBitrix.webhookTitle')}
            </h2>
            <p className="text-sm text-slate-600">
              {t('settingsBitrix.webhookDescription')}
            </p>

            <div className="space-y-2">
              <div className="rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 font-mono text-[12px] text-slate-800">
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

            <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-800">
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-500">
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

