import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { CoraxLogo } from '../components/CoraxLogo'
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
  IconMoon,
  IconPcs,
  IconPrinter,
  IconSoftware,
  IconSun,
  IconTag,
  IconTicket,
  IconUsers,
} from '../components/icons'
import { clearLoginGreeting, peekLoginGreeting } from '../loginGreeting'
import { useTheme } from '../ThemeContext'

function dayGreeting(date = new Date()) {
  const hour = date.getHours()
  if (hour >= 5 && hour < 12) return 'Доброе утро'
  if (hour >= 12 && hour < 18) return 'Добрый день'
  if (hour >= 18 && hour < 23) return 'Добрый вечер'
  return 'Доброй ночи'
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
            className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition ${
              isActive
                ? 'text-[var(--color-primary)]'
                : 'text-[var(--color-fg-subtle)] group-hover:text-[var(--color-fg)]'
            }`}
          >
            <Icon className="h-[15px] w-[15px]" />
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
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-subtle)] transition group-hover:text-[var(--color-fg)]">
          <Icon className="h-[15px] w-[15px]" />
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

export function Layout() {
  const { user, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const displayName = user?.full_name?.trim() || user?.username || ''
  const showUsername =
    Boolean(user?.full_name?.trim()) && user?.username && user.username !== displayName
  const roleLabel = user?.is_superuser
    ? null
    : user?.role === 'editor'
      ? 'Редактор'
      : 'Наблюдатель'
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
  const mobileNavVisible = mobileNavOpen && mobileNavPath === location.pathname
  const menuQueryNorm = normMenuText(menuQuery)

  useEffect(() => {
    if (!user) return
    const stored = peekLoginGreeting()
    if (!stored) return
    const accountName = user.full_name?.trim() || user.username || stored
    setWelcomeToastLeaving(false)
    setWelcomeToast(`${dayGreeting()}, ${accountName}`)
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

  const navSections = useMemo(() => {
    const sections: Array<{
      title: string
      icon: ComponentType<{ className?: string }>
      collapsible?: boolean
      items: Array<{
        to: string
        end?: boolean
        icon: ComponentType<{ className?: string }>
        label: string
        keywords?: string[]
      }>
    }> = [
      {
        title: 'Парк ПК',
        icon: IconPcs,
        collapsible: false,
        items: [
          { to: '/', end: true, icon: IconDashboard, label: 'Дашборд', keywords: ['главная'] },
          { to: '/software', icon: IconSoftware, label: 'Каталог', keywords: ['софт', 'программы'] },
          { to: '/computers', icon: IconPcs, label: 'Парк ПК', keywords: ['компьютеры', 'пк'] },
          { to: '/printers', icon: IconPrinter, label: 'Принтеры' },
        ],
      },
      {
        title: 'Заявки',
        icon: IconTicket,
        collapsible: true,
        items: [
          { to: '/requests', end: true, icon: IconTicket, label: 'Создание заявки', keywords: ['новая заявка'] },
          { to: '/requests/database', end: true, icon: IconTicket, label: 'База' },
          { to: '/requests/templates', end: true, icon: IconTicket, label: 'Шаблоны' },
          { to: '/requests/stats', end: true, icon: IconTicket, label: 'Статистика' },
        ],
      },
      {
        title: 'База знаний',
        icon: IconBook,
        collapsible: true,
        items: [
          { to: '/knowledge-base/sitemap', end: true, icon: IconGraph, label: 'Карта здания', keywords: ['карта знаний', 'sitemap'] },
          { to: '/knowledge-base/wikirag', icon: IconBook, label: 'WikiRAG' },
          { to: '/knowledge-base/warehouse', icon: IconWarehouse, label: 'Склад' },
        ],
      },
    ]
    if (user?.is_superuser || user?.role === 'editor') {
      const settingsItems: Array<{
        to: string
        icon: ComponentType<{ className?: string }>
        label: string
        keywords?: string[]
      }> = [
        { to: '/settings/tags', icon: IconTag, label: 'Теги' },
        { to: '/settings/categories', icon: IconTicket, label: 'Категории' },
      ]
      if (user?.is_superuser) {
        settingsItems.push(
          { to: '/users', icon: IconUsers, label: 'Пользователи' },
          { to: '/settings/ldap', icon: IconKey, label: 'LDAP' },
          { to: '/settings/bitrix24', icon: IconTicket, label: 'Bitrix24' },
          { to: '/settings/database', icon: IconDisk, label: 'База данных', keywords: ['дамп', 'backup', 'postgresql', 'pg_dump', 'импорт', 'экспорт'] },
          { to: '/settings/glpi', icon: IconPcs, label: 'GLPI', keywords: ['импорт', 'экспорт', 'csv'] },
          { to: '/settings/agent-tokens', icon: IconKey, label: 'Токены агентов' },
          { to: '/settings/agent-bundle', icon: IconKey, label: 'Сборка агента', keywords: ['zip', 'батник', 'deploy', 'win7'] },
        )
      }
      sections.push({ title: 'Настройки', icon: IconKey, collapsible: true, items: settingsItems })
    }
    if (!menuQueryNorm) return sections
    return sections
      .map((section) => {
        const titleMatch = normMenuText(section.title).includes(menuQueryNorm)
        if (titleMatch) return section
        const filteredItems = section.items.filter((item) => {
          const hay = [item.label, ...(item.keywords ?? [])].map(normMenuText).join(' ')
          return hay.includes(menuQueryNorm)
        })
        return { ...section, items: filteredItems }
      })
      .filter((section) => section.items.length > 0)
  }, [menuQueryNorm, user?.is_superuser, user?.role])

  const sidebarNav = (
    <>
      <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-4">
        <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center lg:grid-cols-1 lg:justify-items-center">
          <div className="lg:hidden" aria-hidden />
          <CoraxLogo variant="wordmark" alt="CORAX" className="mx-auto justify-self-center" />
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center justify-self-end rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100 lg:hidden"
            onClick={closeNav}
            aria-label="Закрыть меню"
          >
            <IconClose className="h-6 w-6" />
          </button>
        </div>
        <div className="mt-4 h-px w-full bg-[var(--color-border)]" aria-hidden />
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain bg-[var(--color-surface)] px-3 py-4">
        <div className="px-1">
          <input
            value={menuQuery}
            onChange={(e) => setMenuQuery(e.target.value)}
            placeholder="Поиск по меню..."
            className="app-input !min-h-[40px] !py-2"
            aria-label="Поиск разделов меню"
          />
        </div>
        {navSections.map((section) => {
          const forcedOpen = Boolean(menuQueryNorm)
          const open = forcedOpen || section.collapsible === false || openGroups[section.title] !== false
          return (
            <div key={section.title} className="space-y-1">
              {section.collapsible === false ? (
                <NavBlock title={section.title}>
                  {section.items.map((item) => (
                    <SidebarNavLink key={item.to} to={item.to} end={item.end} icon={item.icon} onNavigate={closeNav}>
                      {item.label}
                    </SidebarNavLink>
                  ))}
                </NavBlock>
              ) : (
                <>
                  <SidebarGroupButton
                    label={section.title}
                    icon={section.icon}
                    open={open}
                    onToggle={() =>
                      setOpenGroups((prev) => ({
                        ...prev,
                        [section.title]: !open,
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
                              {item.label}
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
            Ничего не найдено
          </div>
        ) : null}
      </nav>

      <div className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 safe-area-pb">
        <div className="app-panel-sm mb-3 !rounded-2xl !py-3">
          <div className="truncate text-sm font-semibold text-[var(--color-fg)]">{displayName}</div>
          {showUsername ? (
            <div className="mt-1 truncate font-mono text-[11px] font-medium text-[var(--color-fg-subtle)]">
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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            className="app-btn app-btn-secondary !min-h-[44px] flex-1 !px-0"
            aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          >
            {theme === 'dark' ? <IconSun className="h-5 w-5 text-[var(--color-primary)]" /> : <IconMoon className="h-5 w-5 text-[var(--color-primary)]" />}
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
            aria-label="Выйти"
            title="Выйти"
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
          aria-label="Открыть меню"
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
          aria-label="Закрыть меню"
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
          title={desktopNavHidden ? 'Показать меню' : 'Скрыть меню'}
        >
          {desktopNavHidden ? '▶' : '◀'}
        </button>
        <Outlet />
      </main>
    </div>
  )
}
