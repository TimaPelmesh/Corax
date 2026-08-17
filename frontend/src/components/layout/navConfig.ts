import type { PrefsNavItem } from '../UserPrefsPanel'
import {
  IconActivity,
  IconBook,
  IconDashboard,
  IconDisk,
  IconGraph,
  IconKey,
  IconLock,
  IconPcs,
  IconPencil,
  IconPrinter,
  IconSoftware,
  IconTag,
  IconTicket,
  IconUsers,
  IconWarehouse,
} from '../icons'
import type { NavItemDef, NavSectionDef } from './navTypes'

export function prefsNavItems(user: { is_superuser?: boolean; role?: string } | null): PrefsNavItem[] {
  const items: PrefsNavItem[] = [
    { path: '/', labelKey: 'nav.dashboard' },
    { path: '/risks', labelKey: 'nav.risks' },
    { path: '/computers', labelKey: 'nav.computers' },
    { path: '/software', labelKey: 'nav.software' },
    { path: '/printers', labelKey: 'nav.printers' },
    { path: '/network', labelKey: 'nav.network' },
    { path: '/warehouse', labelKey: 'nav.warehouse' },
    { path: '/requests', labelKey: 'nav.requestNew' },
    { path: '/requests/database', labelKey: 'nav.requestList' },
    { path: '/requests/templates', labelKey: 'nav.requestTemplates' },
    { path: '/requests/stats', labelKey: 'nav.requestStats' },
    { path: '/knowledge-base/sitemap', labelKey: 'nav.sitemap' },
    { path: '/knowledge-base/guide', labelKey: 'nav.guide' },
    { path: '/knowledge-base/wikirag', labelKey: 'nav.wikirag' },
    { path: '/knowledge-base/notes', labelKey: 'nav.notes' },
    { path: '/settings/llm', labelKey: 'nav.llm' },
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
}

export function buildNavSections(user: { is_superuser?: boolean; role?: string } | null): NavSectionDef[] {
  const sections: NavSectionDef[] = [
    {
      titleKey: 'nav.inventory',
      icon: IconPcs,
      collapsible: false,
      items: [
        { to: '/', end: true, icon: IconDashboard, labelKey: 'nav.dashboard', keywords: ['home', 'главная'] },
        {
          to: '/risks',
          icon: IconLock,
          labelKey: 'nav.risks',
          keywords: ['risk', 'риски', 'security', 'безопасность', 'ai', 'ии'],
        },
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
          badgeKey: 'software',
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
          to: '/warehouse',
          icon: IconWarehouse,
          labelKey: 'nav.warehouse',
          keywords: ['warehouse', 'ТМЦ', 'stock', 'склад'],
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
          to: '/knowledge-base/guide',
          icon: IconBook,
          labelKey: 'nav.guide',
          keywords: ['руководство', 'справка', 'инструкция', 'guide', 'help'],
        },
        {
          to: '/knowledge-base/wikirag',
          icon: IconBook,
          labelKey: 'nav.wikirag',
          keywords: ['wikirag', 'wiki', 'lm', 'rag', 'чат', 'chat'],
        },
        {
          to: '/knowledge-base/notes',
          icon: IconPencil,
          labelKey: 'nav.notes',
          keywords: ['заметки', 'проекты', 'notes', 'plans', 'документы'],
          badgeKey: 'notes',
        },
      ],
    },
  ]

  const settingsItems: NavItemDef[] = [
    {
      to: '/settings/llm',
      icon: IconActivity,
      labelKey: 'nav.llm',
      keywords: ['ollama', 'lm studio', 'llm', 'модель', 'ассистент', 'ии', 'ai', 'агент'],
    },
  ]
  if (user?.is_superuser || user?.role === 'editor') {
    settingsItems.push(
      { to: '/settings/tags', icon: IconTag, labelKey: 'nav.tags' },
      { to: '/settings/categories', icon: IconTag, labelKey: 'nav.categories', keywords: ['заявки', 'tickets'] },
    )
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
  }
  sections.push({
    titleKey: 'nav.settings',
    icon: IconKey,
    collapsible: true,
    hubTo: '/settings',
    items: settingsItems,
  })
  return sections
}
