import { Suspense, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { AppTopBar } from '../components/AppTopBar'
import { IconClose, IconMenu } from '../components/icons'
import { SettingsNavPanel, SidebarSectionList } from '../components/layout/SidebarNav'
import { buildNavSections, prefsNavItems } from '../components/layout/navConfig'
import { ApiOfflineBanner } from '../components/ApiOfflineBanner'
import { WikiRagIndexWatcher } from '../components/wikirag/WikiRagIndexWatcher'
import { useNavCounts } from '../hooks/useNavCounts'
import { useWelcomeToast } from '../hooks/useWelcomeToast'
import { useLocale } from '../i18n/LocaleContext'

const IS_GECKO =
  typeof document !== 'undefined' && document.documentElement.classList.contains('is-gecko')

function RouteLoader() {
  return (
    <div className="route-loader grid min-h-64 place-items-center" aria-busy="true">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-primary)]" />
        <div className="h-2 w-28 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
          <div className="route-loader-bar h-full rounded-full bg-[var(--color-primary)]" />
        </div>
      </div>
    </div>
  )
}

export function Layout() {
  const { user } = useAuth()
  const { t, isNavHidden } = useLocale()
  const location = useLocation()
  const lockPageScroll =
    location.pathname.startsWith('/knowledge-base/wikirag') || location.pathname.startsWith('/network-map')
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileNavPath, setMobileNavPath] = useState(location.pathname)
  const [desktopNavHidden, setDesktopNavHidden] = useState(false)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
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

  const settingsSection = navSections.find((section) => section.flyout)
  const settingsFlyoutOpen = openGroups['nav.settings'] === true

  const closeSettings = () => {
    setOpenGroups((prev) => (prev['nav.settings'] ? { ...prev, 'nav.settings': false } : prev))
  }

  useEffect(() => {
    if (desktopNavHidden) closeSettings()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopNavHidden])

  useEffect(() => {
    if (!settingsFlyoutOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsFlyoutOpen])

  const sidebarNav = (
    <>
      <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 pr-14 lg:pr-3.5">
        <CoraxLogo variant="sidebar" alt="Corax" />
        <button
          type="button"
          className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] dark:text-[var(--color-fg-subtle)] lg:hidden"
          onClick={closeNav}
          aria-label={t('nav.closeMenu')}
        >
          <IconClose className="h-5 w-5" />
        </button>
      </div>

      <nav className="sidebar-scroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain bg-[var(--color-surface)] px-2.5 py-3">
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

      {settingsSection ? (
        <div
          className={`absolute inset-0 z-20 flex flex-col bg-[var(--color-surface)] transition-transform duration-300 ease-out lg:hidden ${
            settingsFlyoutOpen ? 'translate-x-0' : 'pointer-events-none translate-x-full'
          }`}
          aria-hidden={!settingsFlyoutOpen}
        >
          <SettingsNavPanel
            title={t(settingsSection.titleKey)}
            items={settingsSection.items}
            navCounts={navCounts}
            onNavigate={() => {
              closeNav()
              closeSettings()
            }}
            onBack={closeSettings}
            backLabel={t('common.back')}
            t={t}
          />
        </div>
      ) : null}
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
          <CoraxLogo variant="sidebar" alt="Corax" />
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
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(18.5rem,92vw)] flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-surface)] pl-[env(safe-area-inset-left)] transition-all duration-300 ease-out lg:relative lg:static lg:z-auto lg:max-w-none lg:overflow-visible lg:pl-0 lg:shadow-none ${
          mobileNavVisible ? 'translate-x-0' : '-translate-x-full'
        } ${
          desktopNavHidden
            ? 'lg:w-0 lg:min-w-0 lg:translate-x-[-100%] lg:opacity-0 lg:pointer-events-none'
            : 'lg:w-[16rem] lg:translate-x-0 lg:opacity-100'
        }`}
      >
        {sidebarNav}
      </aside>

      {settingsSection ? (
        <aside
          className={`sidebar-settings-pane h-full shrink-0 flex-col border-[var(--color-border)] bg-[var(--color-surface)] ${
            settingsFlyoutOpen && !desktopNavHidden ? 'sidebar-settings-pane-open' : ''
          }`}
          aria-hidden={!settingsFlyoutOpen || desktopNavHidden}
        >
          <div className="sidebar-flyout-dock flex h-full w-[16rem] flex-col">
            <SettingsNavPanel
              title={t(settingsSection.titleKey)}
              items={settingsSection.items}
              navCounts={navCounts}
              onNavigate={() => undefined}
              t={t}
            />
          </div>
        </aside>
      ) : null}

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
            desktopNavHidden ? 'left-0' : settingsFlyoutOpen ? 'left-[31.9rem]' : 'left-[15.9rem]'
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
          <AppTopBar navItems={allNavForPrefs} />
          <ApiOfflineBanner />
          </div>
          <div
            className={
              lockPageScroll
                ? location.pathname.startsWith('/network-map')
                  ? 'flex min-h-0 flex-1 flex-col overflow-hidden p-0'
                  : 'flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-3 sm:px-5 lg:px-6'
                : 'px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-10 lg:pb-12 lg:pt-8'
            }
          >
            <Suspense fallback={<RouteLoader />}>
              <div
                key={location.pathname}
                className={`${IS_GECKO ? '' : 'route-enter '}${lockPageScroll ? 'flex min-h-0 flex-1 flex-col overflow-hidden' : ''}`}
              >
                <Outlet />
              </div>
            </Suspense>
          </div>
        </div>
      </main>

      <WikiRagIndexWatcher />
    </div>
  )
}
