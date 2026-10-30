type Loader = () => Promise<unknown>

const routes: Array<[string, Loader]> = [
  ['/settings/agent-tokens', () => import('./pages/AgentTokensPage')],
  ['/settings/agent-bundle', () => import('./pages/AgentBundlePage')],
  ['/settings/categories', () => import('./pages/SettingsCategoriesPage')],
  ['/settings/bitrix24', () => import('./pages/SettingsBitrix24Page')],
  ['/settings/database', () => import('./pages/SettingsDatabasePage')],
  ['/settings/https', () => import('./pages/SettingsHttpsPage')],
  ['/settings/ldap', () => import('./pages/SettingsLdapPage')],
  ['/settings/llm', () => import('./pages/SettingsLlmPage')],
  ['/settings/tags', () => import('./pages/SettingsTagsPage')],
  ['/settings/wol', () => import('./pages/SettingsWolPage')],
  ['/settings/zabbix', () => import('./pages/SettingsZabbixPage')],
  ['/settings/glpi', () => import('./pages/SettingsGlpiPage')],
  ['/settings', () => import('./pages/SettingsIndexPage')],
  ['/knowledge-base/sitemap', () => import('./pages/KnowledgeSitemapPage')],
  ['/knowledge-base/wikirag', () => import('./pages/WikiRagPage')],
  ['/knowledge-base/zabbix', () => import('./pages/KnowledgeZabbixPage')],
  ['/knowledge-base/notes', () => import('./pages/NotesPage')],
  ['/knowledge-base/guide', () => import('./pages/GuidePage')],
  ['/server-audit', () => import('./pages/ServerAuditPage')],
  ['/network-map', () => import('./pages/NetworkMapPage')],
  ['/computers', () => import('./pages/ComputersPage')],
  ['/printers', () => import('./pages/PrintersPage')],
  ['/software', () => import('./pages/SoftwarePage')],
  ['/warehouse', () => import('./pages/WarehousePage')],
  ['/network', () => import('./pages/NetworkPage')],
  ['/requests', () => import('./pages/ServiceRequestsPage')],
  ['/risks', () => import('./pages/RiskCenterPage')],
  ['/users', () => import('./pages/UsersPage')],
]

const started = new Set<string>()

function loaderFor(path: string): [string, Loader] | null {
  const clean = path.split('?')[0].split('#')[0] || '/'
  if (clean === '/') return ['/', () => import('./pages/DashboardPage')]
  let best: [string, Loader] | null = null
  for (const entry of routes) {
    const [prefix, load] = entry
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      if (!best || prefix.length > best[0].length) best = [prefix, load]
    }
  }
  return best
}

/** Warm the JS chunk for a menu path. Safe to call often. */
export function prefetchRoute(path: string) {
  const match = loaderFor(path)
  if (!match || started.has(match[0])) return
  started.add(match[0])
  void match[1]().catch(() => {
    started.delete(match[0])
  })
}

/** Layout + home, started while the session request is still in flight. */
export function prefetchShell() {
  if (!started.has('layout')) {
    started.add('layout')
    void import('./pages/Layout').catch(() => {
      started.delete('layout')
    })
  }
  prefetchRoute('/')
}
