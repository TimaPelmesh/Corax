import type { ComponentType, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import {
  IconClose,
  IconDashboard,
  IconDisk,
  IconBook,
  IconGraph,
  IconWarehouse,
  IconKey,
  IconLogo,
  IconLogout,
  IconMenu,
  IconPcs,
  IconPrinter,
  IconSoftware,
  IconTag,
  IconTicket,
  IconUsers,
} from '../components/icons'
import { clearLoginGreeting, peekLoginGreeting } from '../loginGreeting'

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
        `group relative flex min-h-[36px] touch-manipulation items-center gap-2 overflow-hidden rounded-lg border border-transparent px-2.5 py-1.5 text-[15px] font-medium no-underline transition-colors active:scale-[0.99] ${
          isActive
            ? 'bg-neutral-200/80 text-neutral-950'
            : 'text-neutral-700 hover:bg-neutral-100/80 hover:text-neutral-950'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition ${
              isActive
                ? 'text-neutral-900'
                : 'text-neutral-500 group-hover:text-neutral-900'
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
      <div className="mb-1.5 px-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-neutral-400">
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
      className="group flex min-h-[36px] w-full touch-manipulation items-center justify-between rounded-lg border border-transparent px-2.5 py-1.5 text-left text-[15px] font-semibold text-neutral-800 transition hover:bg-neutral-100/80"
      aria-expanded={open}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-500 transition group-hover:text-neutral-900">
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
  const roleLabel = user?.is_superuser ? 'Админ' : user?.role === 'editor' ? 'Редактор' : 'Наблюдатель'
  const roleBadgeClass = user?.is_superuser
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
    : user?.role === 'editor'
      ? 'border-sky-200 bg-sky-50 text-sky-700'
      : 'border-amber-200 bg-amber-50 text-amber-700'
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
      const settingsItems = [
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
      <div className="shrink-0 border-b border-neutral-200/80 bg-gradient-to-b from-white via-white to-red-50/30 px-4 py-5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-2xl bg-gradient-to-br from-red-500 via-red-600 to-neutral-950 text-white shadow-[0_18px_38px_-18px_rgba(220,38,38,0.8)] ring-1 ring-red-400/30">
              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgb(255_255_255/0.28),transparent_54%)]" aria-hidden />
              <IconLogo className="relative h-[1.25rem] w-[1.25rem] drop-shadow-sm" />
            </div>
            <div className="min-w-0">
              <div className="brand-wordmark truncate text-[0.95rem] font-bold leading-tight tracking-tight text-neutral-950">
                CORAX
              </div>
            </div>
          </div>
          <button
            type="button"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 lg:hidden"
            onClick={closeNav}
            aria-label="Закрыть меню"
          >
            <IconClose className="h-6 w-6" />
          </button>
        </div>
        <div className="mt-4 h-px w-full bg-gradient-to-r from-transparent via-red-600/50 to-transparent" aria-hidden />
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-3 py-4">
        <div className="px-0.5">
          <input
            value={menuQuery}
            onChange={(e) => setMenuQuery(e.target.value)}
            placeholder="Поиск по меню..."
            className="w-full rounded-lg border border-neutral-200/90 bg-white px-3 py-1.5 text-sm text-neutral-900 shadow-sm outline-none transition focus:border-red-300 focus:ring-2 focus:ring-red-100"
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
                      <div className="border-l border-neutral-300/90 pl-2">
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
          <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50/70 px-3 py-4 text-center text-xs text-neutral-500">
            Ничего не найдено
          </div>
        ) : null}
      </nav>

      <div className="shrink-0 border-t border-neutral-200/80 bg-gradient-to-b from-white to-neutral-50/90 p-3 safe-area-pb">
        <div className="mb-2 rounded-2xl border border-neutral-200/85 bg-white/90 px-3 py-2.5 shadow-[0_12px_34px_-28px_rgb(15_23_42/0.6)]">
          <div className="truncate font-mono text-xs font-medium text-neutral-700">{user?.username}</div>
          <div className="mt-1">
            <span
              className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] ${roleBadgeClass}`}
            >
              {roleLabel}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            void (async () => {
              await logout()
              window.location.href = '/login'
            })()
          }}
          className="flex min-h-[44px] w-full touch-manipulation items-center justify-center gap-2 rounded-2xl border border-neutral-200/90 bg-white/95 px-3 py-2.5 text-sm font-semibold text-neutral-800 shadow-sm transition hover:border-red-200 hover:bg-red-50/50 hover:text-red-700 active:scale-[0.99]"
        >
          <IconLogout className="h-4 w-4 text-red-500" />
          Выйти
        </button>
      </div>
    </>
  )

  return (
    <div className="app-layout-bg relative isolate flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-white lg:flex-row">
      <header className="safe-area-pt relative z-10 flex h-14 shrink-0 items-center gap-3 border-b border-neutral-200/80 bg-white/90 px-3 backdrop-blur lg:hidden">
        <button
          type="button"
          className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-lg text-neutral-800 transition hover:bg-neutral-100 active:bg-neutral-100"
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
        <span className="brand-wordmark min-w-0 truncate text-base font-bold text-neutral-950">CORAX</span>
      </header>

      {mobileNavVisible ? (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default bg-neutral-950/25 backdrop-blur-[2px] lg:hidden"
          aria-label="Закрыть меню"
          onClick={closeNav}
        />
      ) : null}

      <aside
        id="app-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex h-full w-[min(18.5rem,92vw)] flex-col border-r border-neutral-200/80 bg-white/95 shadow-[20px_0_70px_-48px_rgb(15_23_42/0.65)] backdrop-blur-xl transition-all duration-300 ease-out lg:static lg:z-auto lg:max-w-none lg:shadow-none ${
          mobileNavVisible ? 'translate-x-0' : '-translate-x-full'
        } ${
          desktopNavHidden
            ? 'lg:w-0 lg:min-w-0 lg:translate-x-[-100%] lg:opacity-0 lg:pointer-events-none'
            : 'lg:w-[16rem] lg:translate-x-0 lg:opacity-100'
        }`}
      >
        {sidebarNav}
      </aside>

      <main className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain border-l border-neutral-100 bg-[radial-gradient(circle_at_82%_0%,rgb(254_226_226/0.45),transparent_28rem),linear-gradient(180deg,#fafafa_0%,#f5f5f6_100%)] px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 transition-[padding] sm:px-5 sm:py-6 lg:border-l-0 lg:px-10 lg:pb-12 lg:pt-10">
        {welcomeToast ? (
          <div
            className={`pointer-events-none fixed right-4 top-4 z-[200] max-w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-neutral-200 bg-white/95 px-4 py-3 text-sm text-neutral-800 shadow-[0_18px_44px_-20px_rgba(2,6,23,0.55)] backdrop-blur sm:right-6 sm:top-6 ${
              welcomeToastLeaving ? 'toast-leave-right' : 'toast-enter-right'
            }`}
          >
            <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-950">CORAX</div>
            <div className="mt-1 font-semibold text-neutral-950">{welcomeToast}</div>
          </div>
        ) : null}
        <button
          type="button"
          className={`hidden lg:flex fixed top-24 z-30 items-center rounded-r-xl border border-neutral-200 bg-white/95 px-2 py-3 text-[11px] font-semibold text-neutral-600 shadow-sm transition-all duration-300 hover:bg-neutral-50 ${
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
