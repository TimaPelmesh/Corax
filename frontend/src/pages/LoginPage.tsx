import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../AuthContext'
import { IconLock } from '../components/icons'
import { markLoginGreeting } from '../loginGreeting'

const LS_KEY_REMEMBER = 'inventory.remember_login'
const LS_KEY_USERNAME = 'inventory.saved_username'

export function LoginPage() {
  const nav = useNavigate()
  const { user, loading, refresh } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    try {
      const r = window.localStorage.getItem(LS_KEY_REMEMBER) === '1'
      setRemember(r)
      if (r) {
        setUsername(window.localStorage.getItem(LS_KEY_USERNAME) ?? '')
      }
    } catch {
      // ignore storage failures (privacy mode / blocked)
    }
  }, [])

  useEffect(() => {
    if (!remember) return
    if (!username) return
    savePasswordNow(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remember, username])

  function savePasswordNow(nextRemember: boolean) {
    try {
      window.localStorage.setItem(LS_KEY_REMEMBER, nextRemember ? '1' : '0')
      if (nextRemember) {
        window.localStorage.setItem(LS_KEY_USERNAME, username)
      } else {
        window.localStorage.removeItem(LS_KEY_USERNAME)
      }
    } catch {
      // ignore
    }
  }

  const connectionNote = useMemo(() => '', [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setPending(true)
    try {
      await api.login(username, password)
      savePasswordNow(remember)
      markLoginGreeting(username)
      await refresh()
      nav('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка входа')
    } finally {
      setPending(false)
    }
  }

  const shouldRedirect = !loading && Boolean(user)
  if (shouldRedirect) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden bg-[#030303] px-4 py-10 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:p-8">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(220,38,38,0.26),transparent_34%),radial-gradient(circle_at_75%_28%,rgba(255,255,255,0.08),transparent_24%),linear-gradient(180deg,rgba(8,8,8,0.25),rgba(3,3,3,0.96))]" />
        <div
          className="absolute inset-0 opacity-[0.24]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '52px 52px',
          }}
        />
        <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-red-500/8 to-transparent" />
      </div>

      <div className="relative w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <span className="rounded-full border border-red-500/25 bg-black/40 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-white backdrop-blur-sm">
            CORAX
          </span>
        </div>
        <div className="mb-8 flex items-center justify-center gap-3 sm:gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-black/55 text-white shadow-[0_12px_30px_-14px_rgba(220,38,38,0.9)] ring-1 ring-red-500/25 backdrop-blur-sm">
            <IconLock className="h-6 w-6" aria-hidden />
          </div>
          <div className="min-w-0 text-left">
            <h1 className="text-lg font-semibold tracking-tight text-white">Вход в панель</h1>
            <p className="mt-1 text-sm text-white/60">Инвентаризация рабочих станций</p>
          </div>
        </div>

        <div
          className="relative overflow-hidden rounded-[1.6rem] border border-white/10 bg-black/45 p-8 shadow-[0_32px_90px_-34px_rgba(0,0,0,0.98)] ring-1 ring-red-500/10 backdrop-blur-xl transition duration-500 ease-out"
        >
          <div className="pointer-events-none absolute inset-0 opacity-70" aria-hidden>
            <div className="absolute -left-10 -top-10 h-56 w-56 rounded-full bg-red-500/18 blur-3xl" />
            <div className="absolute -bottom-12 -right-12 h-64 w-64 rounded-full bg-white/6 blur-3xl" />
          </div>

          <form onSubmit={onSubmit} className="space-y-5">
            {error ? (
              <div
                role="alert"
                className="rounded-lg border border-red-500/30 bg-red-950/50 px-4 py-3 text-sm font-medium text-red-100"
              >
                {error}
              </div>
            ) : null}
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/50">
                Логин
              </label>
              <input
                className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-red-500/60 focus:ring-2 focus:ring-red-500/25"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                placeholder="Введите логин"
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/50">
                Пароль
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 pr-12 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-red-500/60 focus:ring-2 focus:ring-red-500/25"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="Введите пароль"
                  required
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-xl text-white/55 transition hover:text-white"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                  title={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                >
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                    {showPassword ? (
                      <>
                        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                        <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
                      </>
                    ) : (
                      <>
                        <path d="M3 3l18 18" />
                        <path d="M10.6 10.6A2.9 2.9 0 0 0 12 15a3 3 0 0 0 3-3c0-.5-.1-1-.3-1.4" />
                        <path d="M6.5 6.5C4.4 8 3 10.5 2 12c0 0 3.5 7 10 7 2.1 0 4-.7 5.6-1.7" />
                        <path d="M14.1 9.9A3 3 0 0 0 9.9 14.1" />
                        <path d="M9.2 4.3C10.1 4.1 11 4 12 4c6.5 0 10 8 10 8-.5.9-1.4 2.3-2.7 3.6" />
                      </>
                    )}
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={pending}
                  onChange={(e) => {
                    const next = e.target.checked
                    setRemember(next)
                    if (!next) savePasswordNow(false)
                  }}
                />
                Запомнить логин
              </label>
            </div>
            <button
              type="submit"
              disabled={pending}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-red-500/35 bg-gradient-to-r from-red-700 via-red-600 to-red-500 py-3 text-sm font-semibold text-white shadow-[0_16px_35px_-18px_rgba(220,38,38,0.95)] transition hover:brightness-110 disabled:opacity-50"
            >
              <IconLock className="h-4 w-4 opacity-80" aria-hidden />
              {pending ? 'Вход…' : 'Войти'}
            </button>
          </form>
        </div>

        {connectionNote ? (
          <p className="mt-6 text-center text-xs leading-relaxed text-white/40">{connectionNote}</p>
        ) : null}
      </div>
    </div>
  )
}
