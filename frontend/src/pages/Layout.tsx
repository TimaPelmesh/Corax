import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { UserPrefsPanel, type PrefsNavItem } from '../components/UserPrefsPanel'
import { UserAvatar } from '../components/UserAvatar'
import {
  IconClose,
  IconDashboard,
  IconDisk,
  IconBook,
  IconGraph,
  IconWarehouse,
  IconKey,
  IconLogout,
  IconMenu,
  IconPcs,
  IconPrinter,
  IconSoftware,
  IconTag,
  IconTicket,
  IconUsers,
  IconPencil,
  IconLock,
  IconSettings,
} from '../components/icons'
import { useLocale, type MessageKey } from '../i18n/LocaleContext'
import { clearLoginGreeting, peekLoginGreeting } from '../loginGreeting'

function dayGreetingKey(date = new Date()): MessageKey {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'greet.morning'
  if (hour >= 12 && hour < 18) return 'greet.afternoon'
  if (hour >= 18 && hour < 23) return 'greet.evening'
  return 'greet.night'
}

function normMenuText(v: string): string {
  return v.trim().toLowerCase()
}

function SidebarNavLink({
  to,
  end,
  icon: Icon,
  children,
  onNavigate,
}: {
  to: string
  end?: boolean
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  onNavigate?: () => void
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group relative flex min-h-[36px] touch-manipulation items-center gap-2 overflow-hidden rounded-lg border border-transparent px-3 py-2 text-[15px] font-medium no-underline transition-colors active:scale-[0.99] ${
          isActive
            ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
            : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition ${
              isActive
                ? 'text-[var(--color-primary)]'
                : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg)]'
            }`}
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <span className="relative min-w-0">{children}</span>
        </>
      )}
    </NavLink>
  )
}

function NavBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 px-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

function SidebarGroupButton({
  label,
  icon: Icon,
  open,
  onToggle,
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  open: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex min-h-[36px] w-full touch-manipulation items-center justify-between rounded-lg border border-transparent px-3 py-2 text-left text-[15px] font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)]"
      aria-expanded={open}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-subtle)] transition group-hover:text-[var(--color-fg)]">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="truncate">{label}</span>
      </span>
      <span
        className={`flex h-5 w-5 items-center justify-center text-neutral-400 transition-all duration-200 ease-out group-hover:text-neutral-700 ${
          open ? 'rotate-180' : 'rotate-0'
        }`}
        aria-hidden
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5">
          <path
            d="M5.5 7.5L10 12l4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    </button>
  )
}

type NavItemDef = {
  to: string
  end?: boolean
  icon: ComponentType<{ className?: string }>
  labelKey: MessageKey
  keywords?: string[]
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [mobileNavPath, setMobileNavPath] = useState(location.pathname)
  const [desktopNavHidden, setDesktopNavHidden] = useState(false)
  const [menuQuery, setMenuQuery] = useState('')
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [welcomeToast, setWelcomeToast] = useState<string | null>(null)
  const [welcomeToastLeaving, setWelcomeToastLeaving] = useState(false)
  const [prefsOpen, setPrefsOpen] = useState(false)
  const mobileNavVisible = mobileNavOpen && mobileNavPath === location.pathname
  const menuQueryNorm = normMenuText(menuQuery)

  useEffect(() => {
    if (!user) return
    const stored = peekLoginGreeting()
    if (!stored) return
    const accountName = user.full_name?.trim() || user.username || stored
    setWelcomeToastLeaving(false)
    setWelcomeToast(`${t(dayGreetingKey())}, ${accountName}`)
  }, [user, t])

  useEffect(() => {
    if (!welcomeToast) return
    const exitTimer = window.setTimeout(() => setWelcomeToastLeaving(true), 4600)
    const removeTimer = window.setTimeout(() => {
      setWelcomeToast(null)
      setWelcomeToastLeaving(false)
      clearLoginGreeting()
    }, 5000)
    return () => {
      window.clearTimeout(exitTimer)
      window.clearTimeout(removeTimer)
    }
  }, [welcomeToast])

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

  const allNavForPrefs: PrefsNavItem[] = useMemo(() => {
    const items: PrefsNavItem[] = [
      { path: '/', labelKey: 'nav.dashboard' },
      { path: '/computers', labelKey: 'nav.computers' },
      { path: '/software', labelKey: 'nav.software' },
      { path: '/printers', labelKey: 'nav.printers' },
      { path: '/network', labelKey: 'nav.network' },
      { path: '/knowledge-base/warehouse', labelKey: 'nav.warehouse' },
      { path: '/requests', labelKey: 'nav.requestNew' },
      { path: '/requests/database', labelKey: 'nav.requestList' },
      { path: '/requests/templates', labelKey: 'nav.requestTemplates' },
      { path: '/requests/stats', labelKey: 'nav.requestStats' },
      { path: '/knowledge-base/sitemap', labelKey: 'nav.sitemap' },
      { path: '/knowledge-base/wikirag', labelKey: 'nav.wikirag' },
    ]
    if (user?.is_superuser || user?.role === 'editor') {
      items.push(
        { path: '/settings/tags', labelKey: 'nav.tags' },
        { path: '/settings/categories', labelKey: 'nav.categories' },
      )
    }
    if (user?.is_superuser) {
      items.push(
        { path: '/users', labelKey: 'nav.users' },
        { path: '/settings/ldap', labelKey: 'nav.ldap' },
        { path: '/settings/bitrix24', labelKey: 'nav.bitrix24' },
        { path: '/settings/database', labelKey: 'nav.database' },
        { path: '/settings/glpi', labelKey: 'nav.glpi' },
        { path: '/settings/agent-tokens', labelKey: 'nav.agentTokens' },
        { path: '/settings/agent-bundle', labelKey: 'nav.agentBundle' },
        { path: '/settings/wol', labelKey: 'nav.wol' },
        { path: '/settings/https', labelKey: 'nav.https' },
      )
    }
    return items
  }, [user?.is_superuser, user?.role])

  const navSections = useMemo(() => {
    const sections: Array<{
      titleKey: MessageKey
      icon: ComponentType<{ className?: string }>
      collapsible?: boolean
      items: NavItemDef[]
    }> = [
      {
        titleKey: 'nav.inventory',
        icon: IconPcs,
        collapsible: false,
        items: [
          { to: '/', end: true, icon: IconDashboard, labelKey: 'nav.dashboard', keywords: ['home', 'главная'] },
          {
            to: '/computers',
            icon: IconPcs,
            labelKey: 'nav.computers',
            keywords: ['парк', 'пк', 'машины', 'pc', 'fleet'],
          },
          {
            to: '/software',
            icon: IconSoftware,
            labelKey: 'nav.software',
            keywords: ['каталог', 'софт', 'программы', 'apps'],
          },
          { to: '/printers', icon: IconPrinter, labelKey: 'nav.printers', keywords: ['snmp', 'toner'] },
          {
            to: '/network',
            icon: IconGraph,
            labelKey: 'nav.network',
            keywords: ['snmp', 'switch', 'router', 'сеть', 'топология', 'lldp'],
          },
          {
            to: '/knowledge-base/warehouse',
            icon: IconWarehouse,
            labelKey: 'nav.warehouse',
            keywords: ['warehouse', 'ТМЦ', 'stock'],
          },
        ],
      },
      {
        titleKey: 'nav.requests',
        icon: IconTicket,
        collapsible: true,
        items: [
          {
            to: '/requests',
            end: true,
            icon: IconPencil,
            labelKey: 'nav.requestNew',
            keywords: ['создание', 'создать', 'new'],
          },
          {
            to: '/requests/database',
            end: true,
            icon: IconTicket,
            labelKey: 'nav.requestList',
            keywords: ['база заявок', 'все заявки', 'list'],
          },
          { to: '/requests/templates', end: true, icon: IconBook, labelKey: 'nav.requestTemplates' },
          { to: '/requests/stats', end: true, icon: IconDashboard, labelKey: 'nav.requestStats' },
        ],
      },
      {
        titleKey: 'nav.knowledge',
        icon: IconBook,
        collapsible: true,
        items: [
          {
            to: '/knowledge-base/sitemap',
            end: true,
            icon: IconGraph,
            labelKey: 'nav.sitemap',
            keywords: ['карта знаний', 'sitemap', 'этаж', 'floor'],
          },
          {
            to: '/knowledge-base/wikirag',
            icon: IconBook,
            labelKey: 'nav.wikirag',
            keywords: ['wikirag', 'wiki', 'lm', 'rag', 'чат', 'chat'],
          },
        ],
      },
    ]
    if (user?.is_superuser || user?.role === 'editor') {
      const settingsItems: NavItemDef[] = [
        { to: '/settings/tags', icon: IconTag, labelKey: 'nav.tags' },
        { to: '/settings/categories', icon: IconTag, labelKey: 'nav.categories', keywords: ['заявки', 'tickets'] },
      ]
      if (user?.is_superuser) {
        settingsItems.push(
          { to: '/users', icon: IconUsers, labelKey: 'nav.users' },
          { to: '/settings/ldap', icon: IconLock, labelKey: 'nav.ldap' },
          { to: '/settings/bitrix24', icon: IconGraph, labelKey: 'nav.bitrix24' },
          {
            to: '/settings/database',
            icon: IconDisk,
            labelKey: 'nav.database',
            keywords: ['дамп', 'backup', 'postgresql', 'pg_dump', 'импорт', 'экспорт'],
          },
          {
            to: '/settings/glpi',
            icon: IconSoftware,
            labelKey: 'nav.glpi',
            keywords: ['импорт', 'экспорт', 'csv'],
          },
          { to: '/settings/agent-tokens', icon: IconKey, labelKey: 'nav.agentTokens' },
          {
            to: '/settings/agent-bundle',
            icon: IconDisk,
            labelKey: 'nav.agentBundle',
            keywords: ['zip', 'батник', 'deploy', 'win7', 'пакет', 'агент', 'agent'],
          },
          {
            to: '/settings/wol',
            icon: IconPcs,
            labelKey: 'nav.wol',
            keywords: ['wake', 'wol', 'включить', 'ping', 'обслуживание'],
          },
          {
            to: '/settings/https',
            icon: IconLock,
            labelKey: 'nav.https',
            keywords: ['ssl', 'tls', 'cert', 'сертификат', 'https', 'шифр'],
          },
        )
      }
      sections.push({ titleKey: 'nav.settings', icon: IconKey, collapsible: true, items: settingsItems })
    }

    const visibleSections = sections
      .map((section) => ({
        ...section,
        items: section.items.filter((item) => !isNavHidden(item.to)),
      }))
      .filter((section) => section.items.length > 0)

    if (!menuQueryNorm) return visibleSections
    return visibleSections
      .map((section) => {
        const titleMatch = normMenuText(t(section.titleKey)).includes(menuQueryNorm)
        if (titleMatch) return section
        const filteredItems = section.items.filter((item) => {
          const hay = [t(item.labelKey), ...(item.keywords ?? [])].map(normMenuText).join(' ')
          return hay.includes(menuQueryNorm)
        })
        return { ...section, items: filteredItems }
      })
      .filter((section) => section.items.length > 0)
  }, [menuQueryNorm, user?.is_superuser, user?.role, isNavHidden, t])

  const sidebarNav = (
    <>
      <div className="relative shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4">
        <div className="flex w-full items-center justify-center">
          <CoraxLogo variant="wordmark" alt="CORAX" className="mx-auto" />
        </div>
        <button
          type="button"
          className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 lg:hidden"
          onClick={closeNav}
          aria-label={t('nav.closeMenu')}
        >
          <IconClose className="h-6 w-6" />
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain bg-[var(--color-surface)] px-3 py-4">
        <div className="px-1">
          <input
            value={menuQuery}
            onChange={(e) => setMenuQuery(e.target.value)}
            placeholder={t('nav.searchMenu')}
            className="app-input !min-h-[40px] !py-2"
            aria-label={t('nav.searchMenuAria')}
          />
        </div>
        {navSections.map((section) => {
          const sectionTitle = t(section.titleKey)
          const forcedOpen = Boolean(menuQueryNorm)
          const open = forcedOpen || section.collapsible === false || openGroups[section.titleKey] !== false
          return (
            <div key={section.titleKey} className="space-y-1">
              {section.collapsible === false ? (
                <NavBlock title={sectionTitle}>
                  {section.items.map((item) => (
                    <SidebarNavLink key={item.to} to={item.to} end={item.end} icon={item.icon} onNavigate={closeNav}>
                      {t(item.labelKey)}
                    </SidebarNavLink>
                  ))}
                </NavBlock>
              ) : (
                <>
                  <SidebarGroupButton
                    label={sectionTitle}
                    icon={section.icon}
                    open={open}
                    onToggle={() =>
                      setOpenGroups((prev) => ({
                        ...prev,
                        [section.titleKey]: !open,
                      }))
                    }
                  />
                  <div
                    className={`ml-2.5 grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                      open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                    aria-hidden={!open}
                  >
                    <div className="overflow-hidden">
                      <div className="border-l border-[var(--color-border)] pl-2">
                        <div className="flex flex-col gap-0.5 py-0.5">
                          {section.items.map((item) => (
                            <SidebarNavLink key={item.to} to={item.to} end={item.end} icon={item.icon} onNavigate={closeNav}>
                              {t(item.labelKey)}
                            </SidebarNavLink>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )
        })}
        {menuQueryNorm && navSections.length === 0 ? (
          <div className="app-panel-sm rounded-xl border-dashed text-center text-xs text-[var(--color-fg-subtle)]">
            {t('common.nothingFound')}
          </div>
        ) : null}
      </nav>

      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 safe-area-pb">
        <div className="app-panel-sm mb-3 !rounded-2xl !py-3">
          <div className="flex items-center gap-3">
            <UserAvatar
              size="md"
              src={user?.avatar_data}
              name={user?.full_name}
              username={user?.username}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-[var(--color-fg)]">{displayName}</div>
              {showUsername ? (
                <div className="mt-0.5 truncate font-mono text-[11px] font-medium text-[var(--color-fg-subtle)]">
                  {user?.username}
                </div>
              ) : null}
              {roleLabel ? (
                <div className="mt-1">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${roleBadgeClass}`}
                  >
                    {roleLabel}
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPrefsOpen(true)}
            className="app-btn app-btn-secondary !min-h-[44px] flex-1 !px-0"
            aria-label={t('prefs.open')}
            title={t('prefs.open')}
          >
            <IconSettings className="h-5 w-5 text-[var(--color-primary)]" />
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await logout()
                window.location.href = '/login'
              })()
            }}
            className="app-btn app-btn-secondary !min-h-[44px] flex-1 !px-0 text-[var(--color-primary)]"
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
          >
            <IconLogout className="h-5 w-5" />
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
          <CoraxLogo variant="wordmark" alt="CORAX" className="h-8" />
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
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(18.5rem,92vw)] flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] transition-all duration-300 ease-out lg:static lg:z-auto lg:max-w-none lg:shadow-none ${
          mobileNavVisible ? 'translate-x-0' : '-translate-x-full'
        } ${
          desktopNavHidden
            ? 'lg:w-0 lg:min-w-0 lg:translate-x-[-100%] lg:opacity-0 lg:pointer-events-none'
            : 'lg:w-[16rem] lg:translate-x-0 lg:opacity-100'
        }`}
      >
        {sidebarNav}
      </aside>

      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain bg-[var(--color-bg)] px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-10 lg:pb-12 lg:pt-10">
        {welcomeToast ? (
          <div
            className={`pointer-events-none fixed right-4 top-4 z-[200] max-w-[min(22rem,calc(100vw-2rem))] app-panel-sm !rounded-2xl text-sm text-[var(--color-fg)] sm:right-6 sm:top-6 ${
              welcomeToastLeaving ? 'toast-leave-right' : 'toast-enter-right'
            }`}
          >
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">CORAX</div>
            <div className="mt-1 font-semibold text-[var(--color-fg)]">{welcomeToast}</div>
          </div>
        ) : null}
        <button
          type="button"
          className={`hidden lg:flex fixed top-24 z-30 items-center rounded-r-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-3 text-[11px] font-semibold text-[var(--color-fg-muted)] transition-all duration-300 hover:bg-[var(--color-surface-muted)] ${
            desktopNavHidden ? 'left-0' : 'left-[15.9rem]'
          }`}
          onClick={() => setDesktopNavHidden((v) => !v)}
          title={desktopNavHidden ? t('nav.showSidebar') : t('nav.hideSidebar')}
        >
          {desktopNavHidden ? '▶' : '◀'}
        </button>
        <Outlet />
      </main>

      <UserPrefsPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} navItems={allNavForPrefs} />
    </div>
  )
}
