import { type FormEvent, useEffect, useState } from 'react'
import { api } from '../api'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { IconLock } from '../components/icons'
import { useLocale } from '../i18n/LocaleContext'

export function ForceChangePasswordPage() {
  const { refresh, logout, user } = useAuth()
  const { t } = useLocale()
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    document.title = t('titles.mustChangePassword')
  }, [t])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (newPassword !== repeat) {
      setError(t('login.mustChangeMismatch'))
      return
    }
    if (newPassword === currentPassword) {
      setError(t('login.mustChangeSame'))
      return
    }
    setPending(true)
    try {
      await api.changeMyPassword({
        current_password: currentPassword,
        new_password: newPassword,
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'))
    } finally {
      setPending(false)
    }
  }

  const fieldInvalid = Boolean(error)

  return (
    <div className="login-page relative flex min-h-dvh w-full flex-col items-center justify-center overflow-hidden px-4 py-10 pb-10 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-8 lg:px-12">
      <div className="login-scene pointer-events-none absolute inset-0" aria-hidden>
        <span className="login-mesh" />
        <span className="login-glow login-glow-a" />
        <span className="login-glow login-glow-b" />
        <span className="login-glow login-glow-c" />
        <span className="login-vignette" />
      </div>

      <div className="relative z-10 flex w-full max-w-5xl flex-col items-center gap-8 sm:gap-10">
        <div className="login-wordmark-row login-logo-mark">
          <CoraxLogo variant="wordmark" alt="Corax" className="login-wordmark" />
        </div>

        <div className="flex w-full flex-col items-center gap-6 lg:flex-row lg:items-stretch lg:justify-center lg:gap-8">
          <div className="login-card-enter login-glass login-bird-shell login-logo-mark">
            <CoraxLogo variant="bird" alt="" />
          </div>

          <div className={`login-card-enter login-glass login-panel w-full max-w-[24rem] shrink-0 ${error ? 'login-glass-error' : ''}`}>
            <div className="login-card-head">
              <div className="min-w-0">
                <h1 className="login-card-title">{t('login.mustChangeTitle')}</h1>
                <p className="login-card-subtitle">{t('login.mustChangeSubtitle')}</p>
                {user?.username ? <p className="mt-2 text-xs text-white/40">{user.username}</p> : null}
              </div>
            </div>

            <form onSubmit={onSubmit} className="login-card-form">
              {error ? (
                <p role="alert" className="rounded-lg border border-red-400/30 bg-red-500/15 px-3 py-2 text-sm text-red-100">
                  {error}
                </p>
              ) : null}

              <div>
                <label className="login-label" htmlFor="must-change-current">
                  {t('login.mustChangeCurrent')}
                </label>
                <div className="login-field">
                  <span className="login-field-icon" aria-hidden>
                    <IconLock className="h-4 w-4" />
                  </span>
                  <input
                    id="must-change-current"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    className={`login-input ${fieldInvalid ? 'login-input-invalid' : ''}`}
                    aria-invalid={fieldInvalid}
                  />
                </div>
              </div>
              <div>
                <label className="login-label" htmlFor="must-change-new">
                  {t('login.mustChangeNew')}
                </label>
                <div className="login-field">
                  <span className="login-field-icon" aria-hidden>
                    <IconLock className="h-4 w-4" />
                  </span>
                  <input
                    id="must-change-new"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className={`login-input ${fieldInvalid ? 'login-input-invalid' : ''}`}
                    aria-invalid={fieldInvalid}
                  />
                </div>
              </div>
              <div>
                <label className="login-label" htmlFor="must-change-repeat">
                  {t('login.mustChangeRepeat')}
                </label>
                <div className="login-field">
                  <span className="login-field-icon" aria-hidden>
                    <IconLock className="h-4 w-4" />
                  </span>
                  <input
                    id="must-change-repeat"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={6}
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                    className={`login-input ${fieldInvalid ? 'login-input-invalid' : ''}`}
                    aria-invalid={fieldInvalid}
                  />
                </div>
              </div>
              <button type="submit" disabled={pending} className="login-submit">
                {pending ? <span className="login-spinner" aria-hidden /> : null}
                {pending ? t('login.mustChangePending') : t('login.mustChangeSubmit')}
              </button>
              <button type="button" className="login-ghost-link" onClick={() => void logout()}>
                {t('nav.logout')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
