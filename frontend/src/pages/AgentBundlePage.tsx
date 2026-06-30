import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Link } from 'react-router-dom'
import { api, type AgentBundleFormat, type AgentBundleProfile, type AgentBundleTarget } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'

const MODULE_LABELS: Record<string, string> = {
  patches: 'Патчи Windows (KB)',
  network: 'Сеть: IP, DNS, шлюзы, Wi‑Fi',
  domain_sessions: 'Пользователь и сессии',
  bitlocker: 'BitLocker',
  tpm_secureboot: 'TPM и Secure Boot',
  antivirus: 'Антивирус / фаервол (WMI)',
  startup: 'Автозагрузка',
  services: 'Службы Windows',
  storage_health: 'Физические диски / health',
  battery: 'Батарея ноутбука',
  windows_features: 'Компоненты Windows (optional features)',
  office: 'Microsoft Office',
  usb_history: 'История USB (реестр)',
  docker_wsl: 'Docker, WSL, Hyper-V',
}

const DEFAULT_PORT = '3001'

function buildServerUrl(host: string, port: string): string {
  const h = host.trim()
  const p = port.trim() || DEFAULT_PORT
  if (!h) return `http://…:${p}`
  return `http://${h}:${p}`
}

export function AgentBundlePage() {
  const { user, loading: authLoading } = useAuth()
  const [serverHost, setServerHost] = useState('')
  const [lanCandidates, setLanCandidates] = useState<string[]>([])
  const [lanLoading, setLanLoading] = useState(true)
  const [serverPort, setServerPort] = useState(DEFAULT_PORT)
  const [platform, setPlatform] = useState<AgentBundleTarget>('win10')
  const [format, setFormat] = useState<AgentBundleFormat>('exe')
  const [exeAvailable, setExeAvailable] = useState<boolean | null>(null)
  const [exeUnavailableReason, setExeUnavailableReason] = useState<string | null>(null)
  const [level, setLevel] = useState<AgentBundleProfile>('full')
  const [tokenLabel, setTokenLabel] = useState('CORAX deploy')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleMode, setScheduleMode] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY')
  const [scheduleTime, setScheduleTime] = useState('09:00')
  const [modules, setModules] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.keys(MODULE_LABELS).map((k) => [k, true])),
  )
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  const serverUrl = useMemo(() => buildServerUrl(serverHost, serverPort), [serverHost, serverPort])

  useEffect(() => {
    if (authLoading || !user?.is_superuser) return
    let cancelled = false
    setLanLoading(true)
    void api
      .agentBundleLanIp()
      .then((r) => {
        if (cancelled) return
        const candidates = r.candidates ?? []
        setLanCandidates(candidates)
        const ip = r.ip ?? candidates[0] ?? ''
        if (ip) setServerHost(ip)
      })
      .catch((ex) => {
        if (cancelled) return
        setErr(ex instanceof Error ? ex.message : 'Не удалось определить LAN IP сервера')
      })
      .finally(() => {
        if (!cancelled) setLanLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, user?.is_superuser])

  useEffect(() => {
    if (authLoading || !user?.is_superuser || platform !== 'win10') return
    let cancelled = false
    void api
      .agentExeStatus()
      .then((r) => {
        if (cancelled) return
        setExeAvailable(r.available)
        setExeUnavailableReason(r.reason)
      })
      .catch(() => {
        if (cancelled) return
        setExeAvailable(false)
        setExeUnavailableReason('Не удалось проверить сборку EXE')
      })
    return () => {
      cancelled = true
    }
  }, [authLoading, user?.is_superuser, platform])
  const isExe = platform === 'win10' && format === 'exe'
  const showModules = platform === 'win10' && format === 'zip' && level === 'custom'
  const moduleList = useMemo(() => Object.keys(MODULE_LABELS), [])
  const enabledModuleCount = useMemo(
    () => Object.values(modules).filter(Boolean).length,
    [modules],
  )

  if (authLoading) {
    return <p className="text-sm text-slate-500">Загрузка…</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  function toggleModule(key: string) {
    setModules((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!serverHost.trim()) {
      setErr('Укажите IP-адрес сервера CORAX в локальной сети')
      return
    }
    setErr(null)
    setOkMsg(null)
    setBusy(true)
    try {
      const label =
        tokenLabel.trim() ||
        (isExe ? 'CORAX EXE deploy' : platform === 'win7' ? 'CORAX deploy win7' : 'CORAX deploy win10')
      const server = buildServerUrl(serverHost, serverPort)
      const filename = isExe
        ? await api.downloadAgentExe({
            server_url: server,
            create_token: true,
            token_label: label,
          })
        : await api.downloadAgentBundle({
            server_url: server,
            target: platform,
            profile: platform === 'win10' ? level : 'full',
            create_token: true,
            token_label: label,
            modules: platform === 'win10' && showModules ? modules : undefined,
            schedule:
              platform === 'win10'
                ? {
                    enabled: scheduleEnabled,
                    mode: scheduleMode,
                    time: scheduleTime,
                    weekday: 'MON',
                    task_name: 'CORAX-Agent',
                  }
                : { enabled: false },
          })
      setOkMsg(isExe ? `Файл скачан: ${filename}` : `Архив скачан: ${filename}`)
    } catch (ex) {
      let msg = ex instanceof Error ? ex.message : 'Ошибка сборки'
      if (msg.includes('Method Not Allowed') || msg.includes('405')) {
        msg +=
          '. На порту 3001, вероятно, не запущен CORAX API — перезапустите start_all.bat или python run.py из корня репозитория.'
      }
      setErr(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconKey className="h-7 w-7 text-red-600" />
        </div>
        <div>
          <h1 className="page-title">Сборка агента</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            {platform === 'win7'
              ? 'Агент для Windows 7: базовый сбор (железо, ОС, ПО, периферия). PowerShell 2.0, без расширенных модулей.'
              : isExe
                ? 'Автономный EXE для Windows 10/11: один файл, встроены IP сервера и токен, окно статуса. Установка Python на ПК не нужна.'
                : 'ZIP с PowerShell-агентом v3: максимальный сбор (патчи, BitLocker, Office и др.). Распакуйте на шару и запускайте corax_send.bat.'}{' '}
            API на порту <code className="text-xs">3001</code>.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                platform === 'win10'
                  ? 'bg-neutral-900 text-white'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
              }`}
              onClick={() => setPlatform('win10')}
            >
              Windows 10 / 11
            </button>
            <button
              type="button"
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                platform === 'win7'
                  ? 'bg-neutral-900 text-white'
                  : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200'
              }`}
              onClick={() => setPlatform('win7')}
            >
              Windows 7
            </button>
          </div>
          {platform === 'win10' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                  format === 'exe'
                    ? 'border-red-300 bg-red-50 text-red-900'
                    : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
                }`}
                disabled={exeAvailable === false}
                title={exeAvailable === false ? exeUnavailableReason ?? undefined : undefined}
                onClick={() => {
                  if (exeAvailable === false) return
                  setFormat('exe')
                }}
              >
                EXE — автономный
              </button>
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
                  format === 'zip'
                    ? 'border-red-300 bg-red-50 text-red-900'
                    : 'border-neutral-200 bg-white text-neutral-700 hover:border-neutral-300'
                }`}
                onClick={() => setFormat('zip')}
              >
                ZIP — PowerShell v3
              </button>
            </div>
          ) : null}
          {platform === 'win10' && exeAvailable === false && exeUnavailableReason ? (
            <p className="mt-2 max-w-2xl text-xs text-amber-800">
              EXE недоступен: {exeUnavailableReason}. Используйте ZIP или установите PyInstaller на сервере CORAX.
            </p>
          ) : null}
        </div>
      </div>

      {err ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{err}</div>
      ) : null}
      {okMsg ? (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          {okMsg}
        </div>
      ) : null}

      <form
        onSubmit={(e) => void onSubmit(e)}
        className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,22rem)] xl:grid-cols-[minmax(0,1fr)_24rem]"
      >
        <div className="app-card min-w-0 space-y-5 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Параметры</h2>

          <div className="grid gap-3 sm:grid-cols-[1fr_7rem]">
            <div>
              <label className="app-label">IP-адрес сервера CORAX</label>
              {lanCandidates.length > 1 ? (
                <select
                  className="app-input font-mono text-sm"
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  required
                >
                  {!serverHost ? <option value="">Выберите интерфейс…</option> : null}
                  {lanCandidates.map((ip) => (
                    <option key={ip} value={ip}>
                      {ip}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="app-input font-mono text-sm"
                  value={serverHost}
                  onChange={(e) => setServerHost(e.target.value)}
                  placeholder={lanLoading ? 'Определяем LAN IP…' : '192.168.1.10'}
                  required
                />
              )}
              <p className="mt-1 text-xs text-slate-500">
                {lanLoading
                  ? 'Определяем локальный IP этой машины…'
                  : 'LAN-IP сервера CORAX (не 127.0.0.1). С рабочих ПК этот адрес должен открываться.'}
              </p>
            </div>
            <div>
              <label className="app-label">Порт</label>
              <input
                className="app-input font-mono text-sm"
                value={serverPort}
                onChange={(e) => setServerPort(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={DEFAULT_PORT}
                required
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-slate-500">
            URL для агента: <code className="font-mono">{serverUrl}</code>
          </p>

          {platform === 'win7' ? (
            <div className="rounded-xl border border-amber-200/80 bg-amber-50/60 px-4 py-3 text-sm text-amber-950">
              Базовый профиль: WMI, реестр ПО, PnP-периферия. Расширенные модули (патчи, BitLocker, Docker и т.д.)
              доступны только в сборке для Windows 10/11.
            </div>
          ) : null}

          {platform === 'win10' && format === 'zip' ? (
            <>
              <div>
                <label className="app-label">Уровень сбора</label>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label
                    className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3 transition ${
                      level === 'full'
                        ? 'border-red-300 bg-red-50/50 ring-1 ring-red-200'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <input
                        type="radio"
                        name="level"
                        checked={level === 'full'}
                        onChange={() => setLevel('full')}
                      />
                      Полный
                    </span>
                    <span className="mt-1 pl-6 text-xs leading-relaxed text-slate-500">
                      Все модули: сеть, патчи, безопасность, Office, Docker/WSL и т.д.
                    </span>
                  </label>
                  <label
                    className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3 transition ${
                      level === 'custom'
                        ? 'border-red-300 bg-red-50/50 ring-1 ring-red-200'
                        : 'border-neutral-200 hover:border-neutral-300'
                    }`}
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                      <input
                        type="radio"
                        name="level"
                        checked={level === 'custom'}
                        onChange={() => setLevel('custom')}
                      />
                      Свой набор
                    </span>
                    <span className="mt-1 pl-6 text-xs leading-relaxed text-slate-500">
                      Включите только нужные модули вручную.
                    </span>
                  </label>
                </div>
              </div>

              {showModules ? (
                <div className="rounded-xl border border-neutral-200 bg-neutral-50/80 p-4">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Модули</div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {moduleList.map((key) => (
                      <label key={key} className="flex cursor-pointer items-start gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={Boolean(modules[key])}
                          onChange={() => toggleModule(key)}
                        />
                        <span>{MODULE_LABELS[key]}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="rounded-xl border border-neutral-200 bg-neutral-50/60 p-4">
            <div className="text-sm font-semibold text-slate-900">Токен агента</div>
            <div className="mt-2 space-y-2 text-xs leading-relaxed text-slate-600">
              <p>
                <strong>Каждая сборка создаёт новый токен.</strong>{' '}
                {isExe ? (
                  <>
                    Токен и адрес сервера вшиваются в <code className="text-[11px]">CORAX-Agent.exe</code> (раздел{' '}
                  </>
                ) : (
                  <>
                    При скачивании ZIP сервер генерирует пару <code className="text-[11px]">public_id.secret</code>,
                    сохраняет хеш в базе (раздел{' '}
                  </>
                )}
                <Link to="/settings/agent-tokens" className="text-red-700 underline-offset-2 hover:underline">
                  Токены агентов
                </Link>
                ){isExe ? '.' : ' и записывает полный токен в agent_env.bat внутри архива.'}
              </p>
              {!isExe ? (
                <p>
                  Повторная сборка — <em>другой</em> токен; старый остаётся в базе, пока не отзовёте. Один ZIP можно
                  раскатать на много ПК.
                </p>
              ) : (
                <p>
                  Сборка EXE на сервере занимает 1–3 минуты. Файл можно копировать на любые ПК Win10/11 — установка не
                  требуется.
                </p>
              )}
              <p>Без токена API отклонит отчёт. Не публикуйте EXE/ZIP и не коммитьте токены.</p>
            </div>
            <div className="mt-3">
              <label className="app-label">Подпись токена в админке (необязательно)</label>
              <input className="app-input" value={tokenLabel} onChange={(e) => setTokenLabel(e.target.value)} />
            </div>
          </div>

          {platform === 'win10' && format === 'zip' ? (
          <div className="space-y-3 rounded-xl border border-neutral-200 p-4">
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />
              Добавить автозапуск по расписанию
            </label>
            <p className="text-xs leading-relaxed text-slate-500">
              В архив попадёт <code className="text-[11px]">install_schedule.bat</code>. Запустите его{' '}
              <strong>от имени администратора</strong> на каждом ПК один раз — создастся задача в Планировщике
              Windows. Само по себе в систему не встраивается, пока bat не выполнен.
            </p>
            {scheduleEnabled ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="app-label">Режим</label>
                  <select
                    className="app-input"
                    value={scheduleMode}
                    onChange={(e) => setScheduleMode(e.target.value as typeof scheduleMode)}
                  >
                    <option value="DAILY">Ежедневно</option>
                    <option value="WEEKLY">Еженедельно (пн)</option>
                    <option value="MONTHLY">Ежемесячно</option>
                  </select>
                </div>
                <div>
                  <label className="app-label">Время</label>
                  <input
                    className="app-input"
                    type="time"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
          <div className="app-card space-y-4 p-5 sm:p-6">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Сборка</h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">Сервер</dt>
                <dd className="max-w-[58%] truncate text-right font-mono text-xs text-slate-800" title={serverUrl}>
                  {serverUrl}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">Платформа</dt>
                <dd className="text-right font-medium text-slate-800">
                  {platform === 'win10' ? 'Windows 10/11' : 'Windows 7'}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">Формат</dt>
                <dd className="text-right font-medium text-slate-800">
                  {platform === 'win7' ? 'ZIP' : format === 'exe' ? 'EXE' : 'ZIP'}
                </dd>
              </div>
              {platform === 'win10' && format === 'zip' ? (
                <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                  <dt className="text-slate-500">Уровень</dt>
                  <dd className="text-right font-medium text-slate-800">
                    {level === 'full' ? 'Полный' : 'Свой набор'}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                <dt className="text-slate-500">Токен</dt>
                <dd className="text-right text-slate-800">Новый при каждой сборке</dd>
              </div>
              {platform === 'win10' && showModules ? (
                <div className="flex justify-between gap-3 border-b border-neutral-100 pb-2">
                  <dt className="text-slate-500">Модулей</dt>
                  <dd className="text-right text-slate-800">{enabledModuleCount}</dd>
                </div>
              ) : null}
              {platform === 'win10' && format === 'zip' ? (
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">Расписание</dt>
                  <dd className="text-right text-slate-800">{scheduleEnabled ? 'install_schedule.bat' : 'Нет'}</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs leading-relaxed text-slate-500">
              {isExe ? (
                <>
                  Один файл <code className="text-[11px]">CORAX-Agent.exe</code> — запуск двойным кликом, окно статуса,
                  встроены сервер и токен.
                </>
              ) : platform === 'win10' ? (
                <>
                  В архиве: <code className="text-[11px]">corax_send.bat</code>,{' '}
                  <code className="text-[11px]">agent_env.bat</code>,{' '}
                  <code className="text-[11px]">agent_config.json</code>, <code className="text-[11px]">lib/</code>.
                </>
              ) : (
                <>
                  В архиве: <code className="text-[11px]">inventory_send_win7.bat</code>,{' '}
                  <code className="text-[11px]">agent_env.bat</code>, PowerShell-скрипты.
                </>
              )}
            </p>
            <button
              type="submit"
              className="app-btn app-btn-primary w-full"
              disabled={
                busy ||
                lanLoading ||
                !serverHost.trim() ||
                (isExe && exeAvailable === false)
              }
            >
              {busy
                ? isExe
                  ? 'Сборка EXE… (1–3 мин)'
                  : 'Сборка…'
                : isExe
                  ? 'Скачать EXE'
                  : 'Скачать ZIP'}
            </button>
          </div>

          <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/70 p-5 text-sm text-slate-600">
            <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Развёртывание</p>
            <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm leading-relaxed">
              {isExe ? (
                <>
                  <li>
                    Скопируйте <code className="text-xs">CORAX-Agent.exe</code> на ПК (флешка, шара, GPO).
                  </li>
                  <li>
                    Запустите от пользователя — откроется окно, отчёт уйдёт на{' '}
                    <code className="text-xs">{serverUrl}</code>.
                  </li>
                  <li>Для регулярного сбора добавьте EXE в Планировщик Windows.</li>
                </>
              ) : (
                <>
                  <li>Распакуйте ZIP в сетевую папку (например <code className="text-xs">\\server\corax\agent</code>).</li>
                  <li>
                    На ПК запустите{' '}
                    <code className="text-xs">
                      {platform === 'win10' ? 'corax_send.bat' : 'inventory_send_win7.bat'}
                    </code>{' '}
                    — отчёт уйдёт на <code className="text-xs">{serverUrl}</code>.
                  </li>
                  {platform === 'win10' ? (
                    <li>
                      Для регулярного сбора: от администратора — <code className="text-xs">install_schedule.bat</code>{' '}
                      (если включали расписание) или GPO.
                    </li>
                  ) : (
                    <li>Расписание: настройте задачу в Планировщике Windows на запуск bat вручную или через GPO.</li>
                  )}
                </>
              )}
              <li>Данные появятся в разделе «Компьютеры» — сводка по ПК.</li>
            </ol>
          </div>
        </div>
      </form>
    </div>
  )
}
