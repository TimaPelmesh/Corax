import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../api'
import { useAuth } from '../AuthContext'
import { useLocale, type MessageKey } from '../i18n/LocaleContext'
import { useTheme } from '../ThemeContext'
import { IconClose, IconMoon, IconSun } from './icons'
import { fileToAvatarDataUrl, UserAvatar } from './UserAvatar'

export type PrefsNavItem = {
  path: string
  labelKey: MessageKey
}

function SectionCard({
  title,
  action,
  children,
  className = '',
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section
      className={`flex min-h-0 flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-2.5">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
          {title}
        </h3>
        {action}
      </div>
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  )
}

export function UserPrefsPanel({
  open,
  onClose,
  navItems,
}: {
  open: boolean
  onClose: () => void
  navItems: PrefsNavItem[]
}) {
  const { t, locale, setLocale, isNavHidden, setNavHidden, showAllNav } = useLocale()
  const { theme, setTheme } = useTheme()
  const { user, setUser } = useAuth()
  const panelRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const saveSeq = useRef(0)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarErr, setAvatarErr] = useState<string | null>(null)
  const [draftAvatar, setDraftAvatar] = useState<string | null>(null)

  const canEditAvatar = Boolean(user && !user.is_ldap && user.role !== 'directory')
  const previewAvatar = draftAvatar ?? user?.avatar_data ?? null

  useEffect(() => {
    if (!open) return
    setAvatarErr(null)
    setDraftAvatar(user?.avatar_data ?? null)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- init only on open
  }, [open, onClose])

  const uniqueItems = useMemo(() => {
    const seen = new Set<string>()
    return navItems.filter((item) => {
      if (seen.has(item.path)) return false
      seen.add(item.path)
      return true
    })
  }, [navItems])

  const saveAvatar = async (avatar_data: string | null) => {
    if (!canEditAvatar || !user) return
    setDraftAvatar(avatar_data)
    setUser({ ...user, avatar_data })

    const seq = ++saveSeq.current
    setAvatarBusy(true)
    setAvatarErr(null)
    try {
      const updated = await api.updateMyProfile({ avatar_data })
      if (seq !== saveSeq.current) return
      const merged = {
        ...user,
        ...updated,
        avatar_data: updated.avatar_data ?? avatar_data,
      }
      setUser(merged)
      setDraftAvatar(merged.avatar_data ?? null)
    } catch (e) {
      if (seq !== saveSeq.current) return
      setAvatarErr(e instanceof Error ? e.message : t('prefs.avatarSaveFailed'))
      try {
        const fresh = await api.me()
        setUser(fresh)
        setDraftAvatar(fresh.avatar_data ?? null)
      } catch {
        /* ignore */
      }
    } finally {
      if (seq === saveSeq.current) setAvatarBusy(false)
    }
  }

  const onPickFile = async (file: File | null) => {
    if (!file) return
    setAvatarErr(null)
    try {
      const dataUrl = await fileToAvatarDataUrl(file)
      await saveAvatar(dataUrl)
    } catch {
      setAvatarErr(t('prefs.avatarBadFile'))
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[120] flex items-end justify-center bg-black/40 p-3 backdrop-blur-[2px] sm:items-center sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-prefs-title"
        className="app-card flex max-h-[min(52rem,calc(100dvh-1.5rem))] w-full max-w-5xl flex-col overflow-hidden shadow-2xl ring-1 ring-black/5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="relative overflow-hidden border-b border-[var(--color-border)] px-5 py-3.5 sm:px-6">
          <div
            className="pointer-events-none absolute inset-0 opacity-90"
            aria-hidden
            style={{
              background:
                'radial-gradient(ellipse at 0% 0%, color-mix(in srgb, var(--color-primary) 18%, transparent), transparent 55%), radial-gradient(ellipse at 100% 0%, color-mix(in srgb, var(--color-primary) 10%, transparent), transparent 45%)',
            }}
          />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <h2 id="user-prefs-title" className="text-lg font-bold tracking-tight text-[var(--color-fg)]">
                {t('prefs.title')}
              </h2>
              <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">{t('prefs.subtitle')}</p>
            </div>
            <button
              type="button"
              className="rounded-lg p-1 text-[var(--color-fg-subtle)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <IconClose className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12 lg:gap-5">
            <SectionCard title={t('prefs.profile')} className="lg:col-span-7">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <UserAvatar
                  size="lg"
                  src={previewAvatar}
                  name={user?.full_name}
                  username={user?.username}
                />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="truncate text-base font-semibold text-[var(--color-fg)]">
                    {user?.full_name?.trim() || user?.username || '—'}
                  </div>
                  {user?.username ? (
                    <div className="truncate text-sm text-[var(--color-fg-subtle)]">@{user.username}</div>
                  ) : null}

                  {!canEditAvatar ? (
                    <p className="text-sm text-[var(--color-fg-muted)]">{t('prefs.avatarDirectoryHint')}</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null
                          e.target.value = ''
                          void onPickFile(f)
                        }}
                      />
                      <button
                        type="button"
                        className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2 text-sm"
                        disabled={avatarBusy}
                        onClick={() => fileRef.current?.click()}
                      >
                        {t('prefs.avatarUpload')}
                      </button>
                      <button
                        type="button"
                        className="text-xs font-semibold text-[var(--color-primary)] hover:underline disabled:opacity-50"
                        disabled={avatarBusy || !previewAvatar}
                        onClick={() => void saveAvatar(null)}
                      >
                        {t('prefs.avatarReset')}
                      </button>
                      {avatarBusy ? (
                        <span className="text-xs text-[var(--color-fg-subtle)]">{t('prefs.avatarSaving')}</span>
                      ) : null}
                      {avatarErr ? <span className="text-xs text-red-600">{avatarErr}</span> : null}
                    </div>
                  )}
                  {canEditAvatar ? (
                    <p className="text-[11px] text-[var(--color-fg-subtle)]">{t('prefs.avatarHint')}</p>
                  ) : null}
                </div>
              </div>
            </SectionCard>

            {/* Язык / тема — без вложенных плашек */}
            <section className="lg:col-span-5">
              <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                {t('prefs.interface')}
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--color-fg-muted)]">{t('prefs.language')}</span>
                  <div className="inline-flex gap-1">
                    {(
                      [
                        { id: 'ru' as const, label: 'RU' },
                        { id: 'en' as const, label: 'EN' },
                      ] as const
                    ).map((opt) => {
                      const active = locale === opt.id
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setLocale(opt.id)}
                          className={`min-w-[3rem] rounded-lg px-3 py-1.5 text-sm font-bold transition ${
                            active
                              ? 'bg-[var(--color-primary)] text-white'
                              : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                          }`}
                        >
                          {opt.label}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div className="h-px bg-[var(--color-border)]" />
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-[var(--color-fg-muted)]">{t('prefs.theme')}</span>
                  <div className="inline-flex gap-1">
                    <button
                      type="button"
                      onClick={() => setTheme('light')}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                        theme === 'light'
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                      }`}
                    >
                      <IconSun className="h-3.5 w-3.5" />
                      {t('prefs.themeLight')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setTheme('dark')}
                      className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                        theme === 'dark'
                          ? 'bg-[var(--color-primary)] text-white'
                          : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                      }`}
                    >
                      <IconMoon className="h-3.5 w-3.5" />
                      {t('prefs.themeDark')}
                    </button>
                  </div>
                </div>
              </div>
            </section>

            <SectionCard
              title={t('prefs.tabs')}
              className="lg:col-span-12"
              action={
                <button
                  type="button"
                  className="text-xs font-semibold text-[var(--color-primary)] hover:underline"
                  onClick={showAllNav}
                >
                  {t('prefs.showAll')}
                </button>
              }
            >
              <p className="mb-3 text-xs text-[var(--color-fg-subtle)]">{t('prefs.tabsHint')}</p>
              <div className="grid max-h-56 grid-cols-1 gap-0.5 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
                {uniqueItems.map((item) => {
                  const visible = !isNavHidden(item.path)
                  return (
                    <label
                      key={item.path}
                      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                    >
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={(e) => setNavHidden(item.path, !e.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                    </label>
                  )
                })}
              </div>
            </SectionCard>
          </div>
        </div>
      </div>
    </div>
  )
}
