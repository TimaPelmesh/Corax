import { Suspense, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { AppTopBar } from '../components/AppTopBar'
import { UserPrefsPanel } from '../components/UserPrefsPanel'
import { UserAvatar } from '../components/UserAvatar'
import { IconClose, IconLogout, IconMenu, IconSettings } from '../components/icons'
import { SidebarSectionList } from '../components/layout/SidebarNav'
import { buildNavSections, prefsNavItems } from '../components/layout/navConfig'
import { WikiRagIndexWatcher } from '../components/wikirag/WikiRagIndexWatcher'
import { useNavCounts } from '../hooks/useNavCounts'
import { useWelcomeToast } from '../hooks/useWelcomeToast'
import { useLocale } from '../i18n/LocaleContext'

function RouteLoader() {
  return (
    <div className="route-loader grid min-h-64 place-items-center" aria-busy="true">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-100 border-t-blue-600" />
        <div className="h-2 w-28 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
          <div className="route-loader-bar h-full rounded-full bg-blue-500" />
        </div>
      </div>
    </div>
  )
}

export function Layout() {
  const { user, logout } = useAuth()
  const { t, isNavHidden } = useLocale()
  const displayName = user?.full_name?.trim() || user?.username || ''
  const showUsername =
    Boolean(user?.full_name?.trim()) && user?.username && user.username !== displayName
  const roleLabel = user?.is_superuser
    ? null
    : user?.role === 'editor'
      ? t('roles.editor')
      : t('roles.viewer')
  const roleBadgeClass =
    user?.role === 'editor'
      ? 'border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/35 dark:bg-sky-500/15 dark:text-sky-300'
      : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/35 dark:bg-amber-500/15 dark:text-amber-300'
  const location = useLocation()
  const lockPageScroll = location.pathname.startsWith('/knowledge-base/wikirag')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileNavPath, setMobileNavPath] = useState(location.pathname)
  const [desktopNavHidden, setDesktopNavHidden] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [prefsOpen, setPrefsOpen] = useState(false)
  const navCounts = useNavCounts(Boolean(user))
  const { welcomeToast, welcomeToastLeaving } = useWelcomeToast(user)
  const mobileNavVisible = mobileNavOpen && mobileNavPath === location.pathname

  useEffect(() => {
    if (!mobileNavVisible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileNavVisible])

  useEffect(() => {
    if (mobileNavVisible) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => {
        document.body.style.overflow = prev
      }
    }
  }, [mobileNavVisible])

  const closeNav = () => {
    setMobileNavOpen(false)
    setMobileNavPath(location.pathname)
  }

  const allNavForPrefs = useMemo(
    () => prefsNavItems(user),
    [user],
  )

  const navSections = useMemo(() => {
    return buildNavSections(user)
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !isNavHidden(item.to)),
      }))
      .filter((section) => section.items.length > 0)
  }, [user, isNavHidden])

  const sidebarNav = (
    <>
      <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4">
        <div className="flex w-full items-center justify-center">
          <CoraxLogo variant="wordmark" alt="Corax" className="sidebar-brand" />
        </div>
        <button
          type="button"
          className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] dark:text-[var(--color-fg-subtle)] lg:hidden"
          onClick={closeNav}
          aria-label={t('nav.closeMenu')}
        >
          <IconClose className="h-6 w-6" />
        </button>
      </div>

      <nav className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain bg-[var(--color-surface)] px-2.5 py-3">
        <SidebarSectionList
          sections={navSections}
          navCounts={navCounts}
          openGroups={openGroups}
          onToggleGroup={(titleKey, currentlyOpen) =>
            setOpenGroups((prev) => ({
              ...prev,
              [titleKey]: !currentlyOpen,
            }))
          }
          onNavigate={closeNav}
          t={t}
        />
      </nav>

      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 safe-area-pb">
        <div className="app-panel-sm mb-2.5 !rounded-xl !py-2.5">
          <div className="flex items-center gap-2.5">
            <UserAvatar
              size="md"
              src={user?.avatar_data}
              name={user?.full_name}
              username={user?.username}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold text-[var(--color-fg)]">{displayName}</div>
              {showUsername ? (
                <div className="mt-0.5 truncate font-mono text-[11px] font-medium text-[var(--color-fg-subtle)]">
                  {user?.username}
                </div>
              ) : null}
              {roleLabel ? (
                <div className="mt-1">
                  <span
                    className={`inline-flex items-center rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] ${roleBadgeClass}`}
                  >
                    {roleLabel}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setPrefsOpen(true)}
            className="sidebar-profile-btn"
            aria-label={t('prefs.open')}
            title={t('prefs.open')}
          >
            <IconSettings className="h-[18px] w-[18px]" />
            <span>{t('prefs.open')}</span>
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await logout()
                window.location.href = '/login'
              })()
            }}
            className="sidebar-profile-btn"
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
          >
            <IconLogout className="h-[18px] w-[18px]" />
            <span>{t('nav.logout')}</span>
          </button>
        </div>
      </div>
    </>
  )

  return (
    <div className="app-layout-bg relative isolate flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-[var(--color-bg)] lg:flex-row">
      <header className="safe-area-pt relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 lg:hidden">
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-lg text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] active:bg-[var(--color-surface-muted)]"
          onClick={() => {
            setMobileNavPath(location.pathname)
            setMobileNavOpen(true)
          }}
          aria-expanded={mobileNavVisible}
          aria-controls="app-sidebar"
          aria-label={t('nav.openMenu')}
        >
          <IconMenu className="h-6 w-6" />
        </button>
        <div className="flex min-w-0 flex-1 items-center">
          <CoraxLogo variant="wordmark" alt="Corax" className="sidebar-brand" />
        </div>
      </header>

      {mobileNavVisible ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-black/40 lg:hidden"
          aria-label={t('nav.closeMenu')}
          onClick={closeNav}
        />
      ) : null}

      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(18.5rem,92vw)] flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] pl-[env(safe-area-inset-left)] transition-all duration-300 ease-out lg:static lg:z-auto lg:max-w-none lg:pl-0 lg:shadow-none ${
          mobileNavVisible ? 'translate-x-0' : '-translate-x-full'
        } ${
          desktopNavHidden
            ? 'lg:w-0 lg:min-w-0 lg:translate-x-[-100%] lg:opacity-0 lg:pointer-events-none'
            : 'lg:w-[16rem] lg:translate-x-0 lg:opacity-100'
        }`}
      >
        {sidebarNav}
      </aside>

      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--color-bg)]">
        {welcomeToast ? (
          <div
            className={`pointer-events-none fixed right-4 z-[200] max-w-[min(22rem,calc(100vw-2rem))] app-panel-sm !rounded-2xl text-sm text-[var(--color-fg)] top-[calc(3.5rem+0.75rem+env(safe-area-inset-top,0px))] sm:right-6 lg:top-6 ${
              welcomeToastLeaving ? 'toast-leave-right' : 'toast-enter-right'
            }`}
          >
            <div className="brand-wordmark !text-[0.95rem] text-[var(--color-fg-muted)]">Corax</div>
            <div className="mt-1 font-semibold text-[var(--color-fg)]">{welcomeToast}</div>
          </div>
        ) : null}
        <button
          type="button"
          className={`sidebar-edge-toggle hidden lg:flex fixed top-24 z-[15] items-center rounded-r-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2.5 text-[11px] font-semibold text-[var(--color-fg-muted)] transition-all duration-300 hover:bg-[var(--color-surface-muted)] ${
            desktopNavHidden ? 'left-0' : 'left-[15.9rem]'
          }`}
          onClick={() => setDesktopNavHidden((v) => !v)}
          title={desktopNavHidden ? t('nav.showSidebar') : t('nav.hideSidebar')}
        >
          {desktopNavHidden ? '▶' : '◀'}
        </button>
        <div
          className={`app-scroll relative z-0 min-h-0 flex-1 overflow-x-hidden overscroll-y-contain ${
            lockPageScroll ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'
          }`}
        >
          <div className={`chrome-glass z-40 px-4 py-3 sm:px-6 lg:px-10 ${lockPageScroll ? 'shrink-0' : 'sticky top-0'}`}>
            <AppTopBar />
          </div>
          <div
            className={
              lockPageScroll
                ? 'flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3 sm:px-5 lg:px-6'
                : 'px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-10 lg:pb-12 lg:pt-8'
            }
          >
            <Suspense fallback={<RouteLoader />}>
              <div
                key={location.pathname}
                className={`route-enter ${lockPageScroll ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : ''}`}
              >
                <Outlet />
              </div>
            </Suspense>
          </div>
        </div>
      </main>

      <UserPrefsPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} navItems={allNavForPrefs} />
      <WikiRagIndexWatcher />
    </div>
  )
}
