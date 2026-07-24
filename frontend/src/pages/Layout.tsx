import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
import { AppTopBar } from '../components/AppTopBar'
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

type NavBadgeKey = 'computers' | 'requestsActive' | 'printers'

type NavCounts = Record<NavBadgeKey, number>

function formatNavBadge(n: number): string {
  if (n > 999) return '999+'
  return String(n)
}

function NavCountBadge({ value }: { value: number | undefined }) {
  if (value == null || value <= 0) return null
  return (
    <span className="ml-auto shrink-0 rounded-full bg-[var(--color-surface-muted)] px-1.5 py-[1px] text-[10px] font-medium tabular-nums leading-[14px] text-[var(--color-fg-subtle)]">
      {formatNavBadge(value)}
    </span>
  )
}

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
  badge,
  onNavigate,
}: {
  to: string
  end?: boolean
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  badge?: number
  onNavigate?: () => void
}) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        `group relative flex min-h-9 touch-manipulation items-center gap-2 overflow-hidden rounded-md border border-transparent px-2.5 py-1 text-[13px] font-medium no-underline transition-colors active:scale-[0.99] lg:min-h-[28px] ${
          isActive
            ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
            : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition ${
              isActive
                ? 'text-[var(--color-primary)]'
                : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg)]'
            }`}
          >
            <Icon className="h-4 w-4" />
          </span>
          <span className="relative min-w-0 flex-1 truncate">{children}</span>
          <NavCountBadge value={badge} />
        </>
      )}
    </NavLink>
  )
}

function NavBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 px-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {title}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </div>
  )
}

function SidebarGroupButton({
  label,
  icon: Icon,
  open,
  badge,
  onToggle,
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  open: boolean
  badge?: number
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="group flex min-h-9 w-full touch-manipulation items-center justify-between rounded-md border border-transparent px-2.5 py-1 text-left text-[13px] font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] lg:min-h-[28px]"
      aria-expanded={open}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-subtle)] transition group-hover:text-[var(--color-fg)]">
          <Icon className="h-4 w-4" />
        </span>
        <span className="truncate">{label}</span>
        <NavCountBadge value={badge} />
      </span>
      <span
        className={`ml-1 flex h-4 w-4 shrink-0 items-center justify-center text-[var(--color-fg-subtle)] transition-all duration-200 ease-out group-hover:text-[var(--color-fg-muted)] ${
          open ? 'rotate-180' : 'rotate-0'
        }`}
        aria-hidden
      >
        <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3">
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
  badgeKey?: NavBadgeKey
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
  const [navCounts, setNavCounts] = useState<NavCounts | null>(null)
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
    if (!user) {
      setNavCounts(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const summary = await api.dashboardSummary()
        if (cancelled) return
        setNavCounts({
          computers: summary.computers_total,
          requestsActive: summary.service_requests_active,
          printers: summary.snmp_printers_total,
        })
      } catch {
        /* badges are optional */
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [user])

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
      badgeKey?: NavBadgeKey
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
            badgeKey: 'computers',
          },
          {
            to: '/software',
            icon: IconSoftware,
            labelKey: 'nav.software',
            keywords: ['каталог', 'софт', 'программы', 'apps'],
          },
          {
            to: '/printers',
            icon: IconPrinter,
            labelKey: 'nav.printers',
            keywords: ['snmp', 'toner'],
            badgeKey: 'printers',
          },
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
        badgeKey: 'requestsActive',
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
            badgeKey: 'requestsActive',
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
          className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] dark:text-[var(--color-fg-subtle)] lg:hidden"
          onClick={closeNav}
          aria-label={t('nav.closeMenu')}
        >
          <IconClose className="h-6 w-6" />
        </button>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain bg-[var(--color-surface)] px-2.5 py-3">
        <div className="px-0.5">
          <input
            value={menuQuery}
            onChange={(e) => setMenuQuery(e.target.value)}
            placeholder={t('nav.searchMenu')}
            className="app-input !min-h-[36px] !py-1.5 !text-[13px]"
            aria-label={t('nav.searchMenuAria')}
          />
        </div>
        {navSections.map((section) => {
          const sectionTitle = t(section.titleKey)
          const forcedOpen = Boolean(menuQueryNorm)
          const open = forcedOpen || section.collapsible === false || openGroups[section.titleKey] !== false
          const sectionBadge = section.badgeKey ? navCounts?.[section.badgeKey] : undefined
          return (
            <div key={section.titleKey} className="space-y-0.5">
              {section.collapsible === false ? (
                <NavBlock title={sectionTitle}>
                  {section.items.map((item) => (
                    <SidebarNavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      icon={item.icon}
                      badge={item.badgeKey ? navCounts?.[item.badgeKey] : undefined}
                      onNavigate={closeNav}
                    >
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
                    badge={sectionBadge}
                    onToggle={() =>
                      setOpenGroups((prev) => ({
                        ...prev,
                        [section.titleKey]: !open,
                      }))
                    }
                  />
                  <div
                    className={`ml-2 grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                      open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                    }`}
                    aria-hidden={!open}
                  >
                    <div className="overflow-hidden">
                      <div className="border-l border-[var(--color-border)] pl-1.5">
                        <div className="flex flex-col gap-px py-0.5">
                          {section.items.map((item) => (
                            <SidebarNavLink
                              key={item.to}
                              to={item.to}
                              end={item.end}
                              icon={item.icon}
                              badge={item.badgeKey ? navCounts?.[item.badgeKey] : undefined}
                              onNavigate={closeNav}
                            >
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
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setPrefsOpen(true)}
            className="app-btn app-btn-secondary !min-h-[36px] flex-1 !rounded-xl !px-0"
            aria-label={t('prefs.open')}
            title={t('prefs.open')}
          >
            <IconSettings className="h-4 w-4 text-[var(--color-primary)]" />
          </button>
          <button
            type="button"
            onClick={() => {
              void (async () => {
                await logout()
                window.location.href = '/login'
              })()
            }}
            className="app-btn app-btn-secondary !min-h-[36px] flex-1 !rounded-xl !px-0 text-[var(--color-primary)]"
            aria-label={t('nav.logout')}
            title={t('nav.logout')}
          >
            <IconLogout className="h-4 w-4" />
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
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">CORAX</div>
            <div className="mt-1 font-semibold text-[var(--color-fg)]">{welcomeToast}</div>
          </div>
        ) : null}
        <button
          type="button"
          className={`hidden lg:flex fixed top-24 z-30 items-center rounded-r-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2.5 text-[11px] font-semibold text-[var(--color-fg-muted)] transition-all duration-300 hover:bg-[var(--color-surface-muted)] ${
            desktopNavHidden ? 'left-0' : 'left-[15.9rem]'
          }`}
          onClick={() => setDesktopNavHidden((v) => !v)}
          title={desktopNavHidden ? t('nav.showSidebar') : t('nav.hideSidebar')}
        >
          {desktopNavHidden ? '▶' : '◀'}
        </button>
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg)]/90 px-4 py-3 backdrop-blur-md sm:px-6 lg:px-10">
          <AppTopBar />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6 lg:px-10 lg:pb-12 lg:pt-8">
          <Outlet />
        </div>
      </main>

      <UserPrefsPanel open={prefsOpen} onClose={() => setPrefsOpen(false)} navItems={allNavForPrefs} />
    </div>
  )
}
