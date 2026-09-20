import { memo, type ComponentType, type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { IconSettings } from '../icons'
import { formatNavBadge } from '../../lib/navBadge'
import type { NavBadgeKey, NavCounts, NavItemDef, NavSectionDef } from './navTypes'

// Badge пересчитывается на каждый рендер Layout (навигация, любое setState),
// а меняется только когда меняется счётчик. memo ловит совпадающий value:number
// без дополнительной работы для React reconciler.
export const NavCountBadge = memo(function NavCountBadge({ value }: { value: number | undefined }) {
  if (value == null || value <= 0) return null
  return (
    <span className="ml-auto shrink-0 rounded-md bg-[var(--color-surface-muted)] px-1.5 py-px text-[10px] font-medium tabular-nums leading-[14px] text-[var(--color-fg-subtle)]">
      {formatNavBadge(value)}
    </span>
  )
})

export function SidebarNavLink({
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
      className={({ isActive }) => `sidebar-link ${isActive ? 'sidebar-link-active' : ''}`}
    >
      <span className="sidebar-link-icon" aria-hidden>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <NavCountBadge value={badge} />
    </NavLink>
  )
}

export function NavBlock({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div>
      {title ? <div className="sidebar-section-label">{title}</div> : null}
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

export function SidebarGroupButton({
  label,
  icon: Icon,
  open,
  badge,
  onToggle,
  to,
  chevronMode = 'down',
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  open: boolean
  badge?: number
  onToggle: () => void
  to?: string
  /** 'down' rotates the caret up when open; 'side' points it right (open ⇒ down). */
  chevronMode?: 'down' | 'side'
}) {
  const body = (
    <span className="flex min-w-0 flex-1 items-center gap-[0.55rem]">
      <span className="sidebar-group-icon" aria-hidden>
        <Icon className="h-4 w-4" />
      </span>
      <span className="truncate">{label}</span>
      <NavCountBadge value={badge} />
    </span>
  )
  const chevron = (
    <span
      className={`sidebar-group-chevron ${chevronMode === 'down' && open ? 'sidebar-group-chevron-open' : ''}`}
      style={chevronMode === 'side' ? { transform: open ? 'rotate(0deg)' : 'rotate(-90deg)' } : undefined}
      aria-hidden
    >
      <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3">
        <path
          d="M5.5 7.5L10 12l4.5-4.5"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )

  if (!to) {
    return (
      <button type="button" onClick={onToggle} className="sidebar-group" aria-expanded={open}>
        {body}
        {chevron}
      </button>
    )
  }

  return (
    <div className="sidebar-group">
      <NavLink to={to} className="flex min-w-0 flex-1 items-center no-underline text-inherit">
        {body}
      </NavLink>
      <button type="button" onClick={onToggle} className="flex h-7 w-7 shrink-0 items-center justify-center" aria-expanded={open} aria-label={label}>
        {chevron}
      </button>
    </div>
  )
}

export function SettingsNavPanel({
  title,
  items,
  navCounts,
  onNavigate,
  onBack,
  backLabel,
  t,
}: {
  title: string
  items: NavItemDef[]
  navCounts: NavCounts | null
  onNavigate: () => void
  onBack?: () => void
  backLabel?: string
  t: (key: NavItemDef['labelKey']) => string
}) {
  return (
    <>
      <div className="relative flex h-14 shrink-0 items-center border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3.5">
        {onBack ? (
          <button
            type="button"
            className="absolute left-2 flex h-9 w-9 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] lg:hidden"
            onClick={onBack}
            aria-label={backLabel ?? title}
          >
            <svg viewBox="0 0 20 20" fill="none" className="h-4 w-4" aria-hidden>
              <path
                d="M12.5 4.5 7 10l5.5 5.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
        <div className="flex w-full items-center justify-center gap-2">
          <span className="sidebar-group-icon text-[var(--color-fg)]" aria-hidden>
            <IconSettings className="h-4 w-4" />
          </span>
          <span className="text-[0.95rem] font-semibold tracking-tight text-[var(--color-fg)]">{title}</span>
        </div>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden px-2.5 py-3">
        {items.map((item) => (
          <SidebarNavLink
            key={item.to}
            to={item.to}
            end={item.end}
            icon={item.icon}
            badge={item.badgeKey ? navCounts?.[item.badgeKey] : undefined}
            onNavigate={onNavigate}
          >
            {t(item.labelKey)}
          </SidebarNavLink>
        ))}
      </nav>
    </>
  )
}

export function SidebarSectionList({
  sections,
  navCounts,
  openGroups,
  onToggleGroup,
  onNavigate,
  t,
}: {
  sections: NavSectionDef[]
  navCounts: NavCounts | null
  openGroups: Record<string, boolean>
  onToggleGroup: (titleKey: string, currentlyOpen: boolean) => void
  onNavigate: () => void
  t: (key: NavSectionDef['titleKey'] | NavItemDef['labelKey']) => string
}) {
  return (
    <>
      {sections.map((section) => {
        const sectionTitle = t(section.titleKey)
        const open = section.collapsible === false || openGroups[section.titleKey] !== false
        const sectionBadge = section.badgeKey ? navCounts?.[section.badgeKey as NavBadgeKey] : undefined
        if (section.flyout) {
          const flyoutOpen = openGroups[section.titleKey] === true
          return (
            <div key={section.titleKey} className="mt-auto border-t border-[var(--color-border)] pt-2">
              <SidebarGroupButton
                label={sectionTitle}
                icon={section.icon}
                open={flyoutOpen}
                badge={sectionBadge}
                onToggle={() => onToggleGroup(section.titleKey, flyoutOpen)}
                chevronMode="side"
              />
            </div>
          )
        }
        return (
          <div key={section.titleKey}>
            {section.collapsible === false ? (
              <NavBlock title={section.hideTitle ? undefined : sectionTitle}>
                {section.items.map((item) => (
                  <SidebarNavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    icon={item.icon}
                    badge={item.badgeKey ? navCounts?.[item.badgeKey] : undefined}
                    onNavigate={onNavigate}
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
                  to={section.hubTo}
                  onToggle={() => onToggleGroup(section.titleKey, open)}
                />
                <div
                  className={`ml-2 grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
                    open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                  }`}
                  aria-hidden={!open}
                >
                  <div className="overflow-hidden">
                    <div className="border-l border-[var(--color-border)] pl-1.5">
                      <div className="flex flex-col gap-0.5 py-0.5">
                        {section.items.map((item) => (
                          <SidebarNavLink
                            key={item.to}
                            to={item.to}
                            end={item.end}
                            icon={item.icon}
                            badge={item.badgeKey ? navCounts?.[item.badgeKey] : undefined}
                            onNavigate={onNavigate}
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
    </>
  )
}
