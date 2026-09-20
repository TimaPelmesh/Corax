import type { ComponentType } from 'react'
import type { MessageKey } from '../../i18n/LocaleContext'

export type NavBadgeKey = 'computers' | 'software' | 'requestsActive' | 'printers' | 'notes'

export type NavCounts = Record<NavBadgeKey, number>

export type NavItemDef = {
  to: string
  end?: boolean
  icon: ComponentType<{ className?: string }>
  labelKey: MessageKey
  keywords?: string[]
  badgeKey?: NavBadgeKey
}

export type NavSectionDef = {
  titleKey: MessageKey
  icon: ComponentType<{ className?: string }>
  collapsible?: boolean
  badgeKey?: NavBadgeKey
  /** When set, the group label navigates here (chevron still toggles). */
  hubTo?: string
  /** Render the group as a side flyout panel instead of an inline expanding list. */
  flyout?: boolean
  /** Hide the section heading in the main sidebar. */
  hideTitle?: boolean
  items: NavItemDef[]
}
