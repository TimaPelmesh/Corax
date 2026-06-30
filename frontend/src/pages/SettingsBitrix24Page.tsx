import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, type Bitrix24Config } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey, IconTicket } from '../components/icons'

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
  const { user } = useAuth()
  const [cfg, setCfg] = useState<Bitrix24Config | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const load = useCallback(async () => {
    setErr(null)
    try {
      setCfg(await api.bitrix24Config())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    }
  }, [])

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
    setErr(null)
    try {
      const next = await api.updateBitrix24Config(patch)
      setCfg(next)
      setToast('Настройки Bitrix24 сохранены.')
      window.setTimeout(() => setToast(null), 3500)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  async function copyWebhook() {
    if (!webhookUrl) return
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setToast('Webhook URL скопирован.')
      window.setTimeout(() => setToast(null), 2500)
    } catch {
      setToast('Не удалось скопировать (попробуйте вручную).')
      window.setTimeout(() => setToast(null), 2500)
    }
  }

  async function runTest() {
    setTesting(true)
    setErr(null)
    try {
      const r = await api.bitrix24IncomingTest({
        title: 'Заявка из Bitrix24 (тест)',
        text: 'Тестовая заявка: сообщение пришло через интеграцию Bitrix24.',
        requester_name: user?.username ?? 'admin',
        category: cfg?.default_category ?? 'bitrix24',
        priority: cfg?.default_priority ?? 'normal',
      })
      setToast(`Тест OK. Создана заявка #${r.request_id}.`)
      window.setTimeout(() => setToast(null), 5000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Тест не прошёл')
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
          <h1 className="page-title">Bitrix24</h1>
          <p className="mt-1 max-w-3xl text-slate-600">
            Входящий webhook для бота/робота: Bitrix24 → наша база заявок. Сценарий: пользователь пишет боту, бот шлёт
            HTTP POST на сервер, заявка появляется в разделе «База заявок».
          </p>
        </div>
      </div>

      {toast ? (
        <div className="mb-4 rounded-xl border border-zinc-200/90 bg-zinc-50 px-4 py-3 text-sm font-medium text-neutral-950 shadow-sm">
          {toast}
        </div>
      ) : null}

      {err ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      {!cfg ? (
        <div className="app-card p-6 text-sm text-slate-600">Загрузка…</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="app-card space-y-3 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Чат-бот (handler URL)</h2>
            <p className="text-sm text-slate-600">
              Если ты используешь встроенный механизм чат-ботов Bitrix24 (URL обработчика бота), то в Bitrix указывается
              путь <span className="font-mono">/handler</span>. Это <strong>не</strong> тот же URL, что ниже (incoming webhook с секретом).
            </p>
            <div className="rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 font-mono text-[12px] text-slate-800">
              {handlerUrlHint}
            </div>
            <p className="text-xs text-slate-500">
              Токен для handler задаётся на сервере в <span className="font-mono">backend/.env</span> как{' '}
              <span className="font-mono">BITRIX24_BOT_HANDLER_TOKEN</span>.
            </p>
          </section>

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Настройки</h2>

            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={saving}
                onChange={(e) => void save({ enabled: e.target.checked })}
              />
              Включить входящие заявки из Bitrix24
            </label>

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="text-xs font-medium text-slate-600">Секрет (shared secret)</label>
                <button
                  type="button"
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                  onClick={() => void save({ incoming_secret: genSecret() })}
                  disabled={saving}
                  title="Сгенерировать новый секрет"
                >
                  Сгенерировать
                </button>
              </div>
              <div className="flex gap-2">
                <input
                  className="app-input font-mono text-[13px]"
                  value={cfg.incoming_secret}
                  onChange={(e) => setCfg({ ...cfg, incoming_secret: e.target.value })}
                  placeholder="секрет"
                />
                <button
                  type="button"
                  className="app-btn app-btn-secondary shrink-0"
                  disabled={saving}
                  onClick={() => void save({ incoming_secret: cfg.incoming_secret })}
                >
                  <IconKey className="h-4 w-4 text-neutral-400" />
                  Сохранить
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Нужен, чтобы в локальной сети никто не мог создать заявки простым POST.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Категория по умолчанию</label>
                <input
                  className="app-input"
                  value={cfg.default_category}
                  onChange={(e) => setCfg({ ...cfg, default_category: e.target.value })}
                  onBlur={() => void save({ default_category: cfg.default_category })}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600">Приоритет по умолчанию</label>
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
                {testing ? 'Тест…' : 'Отправить тестовую заявку'}
              </button>
              <span className="text-xs text-slate-500">Создаст запись в «База заявок».</span>
            </div>
          </section>

          <section className="app-card space-y-4 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Webhook URL</h2>
            <p className="text-sm text-slate-600">
              Этот URL указываешь в Bitrix24 (бот/робот/исходящий webhook). Формат: POST JSON (или form-data) → заявка
              создаётся в нашей системе.
            </p>

            <div className="space-y-2">
              <div className="rounded-xl border border-slate-200/90 bg-slate-50/60 p-3 font-mono text-[12px] text-slate-800">
                {webhookUrl}
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="app-btn app-btn-secondary" onClick={() => void copyWebhook()}>
                  Скопировать URL
                </button>
                <button type="button" className="app-btn app-btn-secondary" onClick={() => void load()}>
                  Обновить
                </button>
              </div>
            </div>

            <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-800">
              <div className="text-xs font-bold uppercase tracking-[0.12em] text-neutral-500">Пример JSON</div>
              <pre className="mt-2 overflow-auto rounded-lg bg-neutral-950 p-3 text-[12px] text-white">
{`{
  "title": "Не печатает принтер",
  "text": "Принтер HP Color 500 в кабинете 101. Ошибка бумаги.",
  "requester_name": "Иван",
  "location": "Каб. 101",
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

