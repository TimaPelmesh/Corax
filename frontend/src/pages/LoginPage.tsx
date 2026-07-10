import type { FormEvent } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { IconLock } from '../components/icons'
import { markLoginGreeting } from '../loginGreeting'

const LS_KEY_REMEMBER = 'inventory.remember_login'
const LS_KEY_USERNAME = 'inventory.saved_username'
const ERROR_VISIBLE_MS = 4800
const ERROR_EXIT_MS = 5200

type ErrorPhase = 'hidden' | 'in' | 'out'

export function LoginPage() {
  const nav = useNavigate()
  const { user, loading, refresh } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorPhase, setErrorPhase] = useState<ErrorPhase>('hidden')
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

  useEffect(() => {
    if (!error) return

    setErrorPhase('in')
    const hideTimer = window.setTimeout(() => setErrorPhase('out'), ERROR_VISIBLE_MS)
    const clearTimer = window.setTimeout(() => {
      setError(null)
      setErrorPhase('hidden')
    }, ERROR_EXIT_MS)

    return () => {
      window.clearTimeout(hideTimer)
      window.clearTimeout(clearTimer)
    }
  }, [error])

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
    setErrorPhase('hidden')
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
    <div className="relative flex min-h-dvh w-full items-center justify-start overflow-hidden bg-[#030303] px-4 py-10 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-10 lg:px-14">
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_50%,rgba(37,99,235,0.2),transparent_36%),radial-gradient(circle_at_78%_42%,rgba(34,211,238,0.12),transparent_32%),radial-gradient(circle_at_92%_68%,rgba(99,102,241,0.14),transparent_28%),linear-gradient(180deg,rgba(8,8,8,0.12),rgba(3,3,3,0.98))]" />
        <div
          className="absolute inset-0 opacity-[0.14]"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)',
            backgroundSize: '52px 52px',
          }}
        />
      </div>

      {error ? (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] sm:top-6">
          <div
            role="alert"
            className={[
              'login-error-toast pointer-events-auto w-full max-w-[min(22rem,calc(100vw-2rem))]',
              errorPhase === 'in' ? 'login-error-toast-in' : '',
              errorPhase === 'out' ? 'login-error-toast-out' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="flex items-start gap-3 rounded-2xl border border-red-500/35 bg-black/80 px-4 py-3.5 text-sm text-red-100 shadow-[0_24px_60px_-20px_rgba(37,99,235,0.55)] ring-1 ring-red-500/20 backdrop-blur-xl">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500/20 text-xs font-bold text-red-300">
                !
              </span>
              <p className="font-medium leading-snug">{error}</p>
            </div>
          </div>
        </div>
      ) : null}

      <div className="relative z-10 flex w-full max-w-[1180px] flex-col items-center gap-10 lg:ml-[max(2.75rem,7vw)] lg:flex-row lg:items-center lg:justify-start lg:gap-10 xl:ml-[max(3.5rem,10vw)] xl:gap-12">
        <div className="relative z-20 flex w-full shrink-0 items-center justify-center lg:flex-1 lg:justify-start">
          <div className="login-brand-stage relative flex min-h-[min(72vw,420px)] w-full max-w-[560px] translate-x-1 items-center justify-center sm:min-h-[380px] sm:translate-x-2 lg:min-h-[460px] lg:max-w-[620px] lg:translate-x-5 xl:translate-x-8">
            <div className="login-brand-backdrop pointer-events-none absolute inset-0" aria-hidden>
              <div className="login-brand-orb login-brand-orb-a" />
              <div className="login-brand-orb login-brand-orb-b" />
              <div className="login-brand-orb login-brand-orb-c" />
              <svg className="login-brand-leaf login-brand-leaf-a" viewBox="0 0 80 120" fill="none">
                <path
                  d="M40 8C18 34 10 68 14 104C34 88 52 58 58 28C54 18 48 12 40 8Z"
                  fill="url(#login-leaf-a)"
                  opacity="0.55"
                />
                <defs>
                  <linearGradient id="login-leaf-a" x1="14" y1="8" x2="58" y2="104" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#22d3ee" stopOpacity="0.5" />
                    <stop offset="1" stopColor="#2563eb" stopOpacity="0.15" />
                  </linearGradient>
                </defs>
              </svg>
              <svg className="login-brand-leaf login-brand-leaf-b" viewBox="0 0 80 120" fill="none">
                <path
                  d="M40 10C58 30 66 62 60 98C42 84 28 58 22 32C26 20 32 14 40 10Z"
                  fill="url(#login-leaf-b)"
                  opacity="0.45"
                />
                <defs>
                  <linearGradient id="login-leaf-b" x1="22" y1="10" x2="66" y2="98" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#60a5fa" stopOpacity="0.45" />
                    <stop offset="1" stopColor="#1e40af" stopOpacity="0.1" />
                  </linearGradient>
                </defs>
              </svg>
              <svg className="login-brand-leaf login-brand-leaf-c" viewBox="0 0 60 60" fill="none">
                <ellipse cx="30" cy="30" rx="22" ry="10" fill="#38bdf8" opacity="0.12" transform="rotate(-24 30 30)" />
              </svg>
            </div>
            <CoraxLogo
              animated
              className="relative z-10 drop-shadow-[0_28px_80px_rgba(37,99,235,0.35)]"
            />
          </div>
        </div>

        <div className="login-card-enter relative z-20 w-full max-w-[420px] shrink-0 lg:max-w-[440px]">
          <div className="relative overflow-hidden rounded-[1.75rem] border border-white/12 bg-black/50 p-8 shadow-[0_40px_100px_-36px_rgba(0,0,0,0.98),0_0_0_1px_rgba(37,99,235,0.08)] ring-1 ring-blue-500/15 backdrop-blur-xl">
            <div className="pointer-events-none absolute inset-0 opacity-80" aria-hidden>
              <div className="absolute -left-12 -top-12 h-56 w-56 rounded-full bg-blue-500/20 blur-3xl" />
              <div className="absolute -bottom-14 -right-14 h-64 w-64 rounded-full bg-white/5 blur-3xl" />
              <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-blue-400/40 to-transparent" />
            </div>

            <div className="relative mb-6">
              <h1 className="text-lg font-semibold tracking-tight text-white">Вход в панель</h1>
              <p className="mt-1.5 text-sm text-white/55">Учётная запись администратора или оператора</p>
            </div>

            <form onSubmit={onSubmit} className="relative space-y-5">
              <div className="login-field-enter">
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/50">
                  Логин
                </label>
                <input
                  className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/25"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="Введите логин"
                  required
                />
              </div>
              <div className="login-field-enter">
                <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-white/50">
                  Пароль
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5 pr-12 text-sm text-white outline-none transition placeholder:text-white/35 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/25"
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

              <div className="login-field-enter flex flex-wrap items-center justify-between gap-3">
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
                className="login-field-enter app-btn app-btn-primary !w-full !min-h-[48px]"
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
    </div>
  )
}
