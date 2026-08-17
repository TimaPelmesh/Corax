import type { ComponentType, ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { formatNavBadge } from '../../lib/navBadge'
import type { NavBadgeKey, NavCounts, NavItemDef, NavSectionDef } from './navTypes'

export function NavCountBadge({ value }: { value: number | undefined }) {
  if (value == null || value <= 0) return null
  return (
    <span className="ml-auto shrink-0 rounded-full bg-[var(--color-surface-muted)] px-1.5 py-[1px] text-[10px] font-medium tabular-nums leading-[14px] text-[var(--color-fg-subtle)]">
      {formatNavBadge(value)}
    </span>
  )
}

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

export function NavBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 px-2.5 text-[10px] font-bold uppercase tracking-[0.16em] text-[var(--color-fg-subtle)]">
        {title}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
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
}: {
  label: string
  icon: ComponentType<{ className?: string }>
  open: boolean
  badge?: number
  onToggle: () => void
  to?: string
}) {
  const body = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-subtle)] transition group-hover:text-[var(--color-fg)]">
        <Icon className="h-4 w-4" />
      </span>
      <span className="truncate">{label}</span>
      <NavCountBadge value={badge} />
    </span>
  )
  const chevron = (
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
  )

  if (!to) {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="group flex min-h-9 w-full touch-manipulation items-center justify-between rounded-md border border-transparent px-2.5 py-1 text-left text-[13px] font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] lg:min-h-[28px]"
        aria-expanded={open}
      >
        {body}
        {chevron}
      </button>
    )
  }

  return (
    <div className="group flex min-h-9 w-full touch-manipulation items-center rounded-md border border-transparent text-[13px] font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] lg:min-h-[28px]">
      <NavLink
        to={to}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1 no-underline text-inherit"
      >
        {body}
      </NavLink>
      <button
        type="button"
        onClick={onToggle}
        className="flex h-9 w-8 shrink-0 items-center justify-center lg:h-7"
        aria-expanded={open}
        aria-label={label}
      >
        {chevron}
      </button>
    </div>
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
                      <div className="flex flex-col gap-px py-0.5">
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
