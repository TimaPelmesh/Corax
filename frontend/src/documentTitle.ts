import type { MessageKey } from './i18n/LocaleContext'
import { translateStatic } from './i18n/LocaleContext'
import type { Locale } from './i18n/types'

/** Browser tab title by route (aligned with app menu). */
const ROUTE_TITLES: Array<{ path: string; key: MessageKey; end?: boolean }> = [
  { path: '/login', key: 'titles.login' },
  { path: '/requests/database', key: 'titles.requestList' },
  { path: '/requests/templates', key: 'titles.requestTemplates' },
  { path: '/requests/stats', key: 'titles.requestStats' },
  { path: '/requests', key: 'titles.requestNew', end: true },
  { path: '/knowledge-base/sitemap', key: 'titles.sitemap' },
  { path: '/knowledge-base/wikirag', key: 'titles.wikirag' },
  { path: '/knowledge-base/warehouse', key: 'titles.warehouse' },
  { path: '/settings/agent-tokens', key: 'titles.agentTokens' },
  { path: '/settings/agent-bundle', key: 'titles.agentBundle' },
  { path: '/settings/categories', key: 'titles.categories' },
  { path: '/settings/bitrix24', key: 'titles.bitrix24' },
  { path: '/settings/database', key: 'titles.database' },
  { path: '/settings/ldap', key: 'titles.ldap' },
  { path: '/settings/glpi', key: 'titles.glpi' },
  { path: '/settings/tags', key: 'titles.tags' },
  { path: '/software', key: 'titles.software' },
  { path: '/computers', key: 'titles.computers' },
  { path: '/printers', key: 'titles.printers' },
  { path: '/users', key: 'titles.users' },
  { path: '/', key: 'titles.dashboard', end: true },
]

const DEFAULT_TITLE = 'CORAX'

export function titleForPath(pathname: string, locale?: Locale): string {
  const path = pathname.replace(/\/+$/, '') || '/'
  for (const row of ROUTE_TITLES) {
    if (row.end ? path === row.path : path === row.path || path.startsWith(`${row.path}/`)) {
      return translateStatic(row.key, locale)
    }
  }
  return DEFAULT_TITLE
}
