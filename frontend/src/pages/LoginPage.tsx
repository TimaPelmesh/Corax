import type { FocusEvent, FormEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { useLocale } from '../i18n/LocaleContext'
import { markLoginGreeting } from '../loginGreeting'

const LS_KEY_REMEMBER = 'inventory.remember_login'
const LS_KEY_USERNAME = 'inventory.saved_username'
const ERROR_VISIBLE_MS = 4800
const ERROR_EXIT_MS = 5200

type ErrorPhase = 'hidden' | 'in' | 'out'

function LoginUserIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <circle cx="12" cy="8" r="3.25" />
      <path d="M5.5 19.5v-1.1a5.1 5.1 0 0 1 5.1-5.1h2.8a5.1 5.1 0 0 1 5.1 5.1v1.1" />
    </svg>
  )
}

function LoginLockIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="5.5" y="10.25" width="13" height="10" rx="2.1" />
      <path d="M8.5 10.25V8a3.5 3.5 0 0 1 7 0v2.25" />
    </svg>
  )
}

function LoginField({
  id,
  label,
  icon,
  children,
}: {
  id: string
  label: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <div className="login-field-enter">
      <label className="login-label" htmlFor={id}>
        {label}
      </label>
      <div className="login-field">
        <span className="login-field-icon" aria-hidden>
          {icon}
        </span>
        {children}
      </div>
    </div>
  )
}

export function LoginPage() {
  const nav = useNavigate()
  const { user, loading, refresh } = useAuth()
  const { t, locale, setLocale } = useLocale()
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [remember, setRemember] = useState(false)
  const [capsOn, setCapsOn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [errorPhase, setErrorPhase] = useState<ErrorPhase>('hidden')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    let savedUser = ''
    try {
      const r = window.localStorage.getItem(LS_KEY_REMEMBER) === '1'
      setRemember(r)
      if (r) {
        savedUser = window.localStorage.getItem(LS_KEY_USERNAME) ?? ''
        setUsername(savedUser)
      }
    } catch {
      // ignore storage failures (privacy mode / blocked)
    }
    const id = window.requestAnimationFrame(() => {
      if (savedUser) passwordRef.current?.focus()
      else usernameRef.current?.focus()
    })
    return () => window.cancelAnimationFrame(id)
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

  function syncCaps(
    e: KeyboardEvent<HTMLInputElement> | MouseEvent<HTMLInputElement> | FocusEvent<HTMLInputElement>,
  ) {
    if ('getModifierState' in e) {
      setCapsOn(e.getModifierState('CapsLock'))
      return
    }
    const native = e.nativeEvent as unknown as { getModifierState?: (key: string) => boolean }
    setCapsOn(Boolean(native.getModifierState?.('CapsLock')))
  }

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
      setError(err instanceof Error ? err.message : t('login.failed'))
    } finally {
      setPending(false)
    }
  }

  const shouldRedirect = !loading && Boolean(user)
  if (shouldRedirect) {
    return <Navigate to="/" replace />
  }

  const canSubmit = username.trim().length > 0 && password.length > 0 && !pending
  const fieldInvalid = Boolean(error)

  return (
    <main className="login-page">
      <div className="login-scene" aria-hidden>
        <span className="login-mesh" />
        <span className="login-glow login-glow-a" />
        <span className="login-glow login-glow-b" />
      </div>

      {error ? (
        <div className="login-error-wrap">
          <div
            role="alert"
            className={[
              'login-error-toast',
              errorPhase === 'in' ? 'login-error-toast-in' : '',
              errorPhase === 'out' ? 'login-error-toast-out' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <div className="login-error-content">{error}</div>
          </div>
        </div>
      ) : null}

      <section className="login-shell" aria-label={t('login.title')}>
        <div className="login-brand-panel login-card-enter">
          <div className="login-wordmark-row login-logo-mark">
            <CoraxLogo variant="wordmark" alt="Corax" className="login-wordmark" />
          </div>

          <div className="login-bird-shell login-logo-mark">
            <CoraxLogo variant="bird" alt="" />
          </div>
        </div>

        <div
          className={['login-panel login-card-enter', error ? 'login-panel-error' : '']
            .filter(Boolean)
            .join(' ')}
        >
          <div className="login-card-head">
            <div className="min-w-0">
              <h1 className="login-card-title">{t('login.title')}</h1>
            </div>
            <div className="login-seg" role="group" aria-label={t('prefs.language')}>
              <button
                type="button"
                onClick={() => setLocale('ru')}
                aria-pressed={locale === 'ru'}
                className={`login-seg-btn ${locale === 'ru' ? 'login-seg-btn-on' : ''}`}
              >
                RU
              </button>
              <button
                type="button"
                onClick={() => setLocale('en')}
                aria-pressed={locale === 'en'}
                className={`login-seg-btn ${locale === 'en' ? 'login-seg-btn-on' : ''}`}
              >
                EN
              </button>
            </div>
          </div>

          <form onSubmit={onSubmit} className="login-card-form">
            <LoginField id="login-username" label={t('login.username')} icon={<LoginUserIcon />}>
              <input
                ref={usernameRef}
                id="login-username"
                name="username"
                className={`login-input ${fieldInvalid ? 'login-input-invalid' : ''}`}
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder={t('login.usernamePh')}
                required
                aria-invalid={fieldInvalid}
              />
            </LoginField>

            <LoginField id="login-password" label={t('login.password')} icon={<LoginLockIcon />}>
              <input
                ref={passwordRef}
                id="login-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                className={`login-input login-input-secret ${fieldInvalid ? 'login-input-invalid' : ''}`}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyUp={syncCaps}
                onKeyDown={syncCaps}
                onMouseDown={syncCaps}
                onFocus={syncCaps}
                autoComplete="current-password"
                placeholder={t('login.passwordPh')}
                required
                aria-invalid={fieldInvalid}
                aria-describedby={capsOn ? 'login-caps' : undefined}
              />
              <button
                type="button"
                className="login-eye"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? t('common.hidePassword') : t('common.showPassword')}
                title={showPassword ? t('common.hidePassword') : t('common.showPassword')}
              >
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
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
            </LoginField>

            {capsOn ? (
              <p id="login-caps" className="login-caps" role="status">
                {t('login.capsOn')}
              </p>
            ) : null}

            <div className="login-field-enter login-card-row">
              <label className="login-remember">
                <input
                  type="checkbox"
                  className="login-check"
                  checked={remember}
                  disabled={pending}
                  onChange={(e) => {
                    const next = e.target.checked
                    setRemember(next)
                    if (!next) savePasswordNow(false)
                  }}
                />
                <span>{t('login.remember')}</span>
              </label>
            </div>

            <button type="submit" disabled={!canSubmit} className="login-field-enter login-submit">
              {pending ? <span className="login-spinner" aria-hidden /> : null}
              {pending ? t('login.submitting') : t('login.submit')}
            </button>
          </form>
        </div>
      </section>
    </main>
  )
}
