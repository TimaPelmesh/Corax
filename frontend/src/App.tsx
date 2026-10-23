import { Suspense, useEffect } from 'react'
import { lazyPage } from './lazyPage'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { titleForPath } from './documentTitle'
import { useLocale } from './i18n/LocaleContext'
import { legacySelfServiceLocation } from './lib/helpdeskRedirect'
import { LoginPage } from './pages/LoginPage'

const ForceChangePasswordPage = lazyPage(() =>
  import('./pages/ForceChangePasswordPage').then((module) => ({ default: module.ForceChangePasswordPage })),
)
const Layout = lazyPage(() => import('./pages/Layout').then((module) => ({ default: module.Layout })))
const DashboardPage = lazyPage(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
)
const RiskCenterPage = lazyPage(() =>
  import('./pages/RiskCenterPage').then((module) => ({ default: module.RiskCenterPage })),
)
const ComputersPage = lazyPage(() =>
  import('./pages/ComputersPage').then((module) => ({ default: module.ComputersPage })),
)
const ServerAuditPage = lazyPage(() =>
  import('./pages/ServerAuditPage').then((module) => ({ default: module.ServerAuditPage })),
)
const SoftwarePage = lazyPage(() =>
  import('./pages/SoftwarePage').then((module) => ({ default: module.SoftwarePage })),
)
const AgentTokensPage = lazyPage(() =>
  import('./pages/AgentTokensPage').then((module) => ({ default: module.AgentTokensPage })),
)
const AgentBundlePage = lazyPage(() =>
  import('./pages/AgentBundlePage').then((module) => ({ default: module.AgentBundlePage })),
)
const SettingsIndexPage = lazyPage(() =>
  import('./pages/SettingsIndexPage').then((module) => ({ default: module.SettingsIndexPage })),
)
const SettingsLdapPage = lazyPage(() =>
  import('./pages/SettingsLdapPage').then((module) => ({ default: module.SettingsLdapPage })),
)
const SettingsWolPage = lazyPage(() =>
  import('./pages/SettingsWolPage').then((module) => ({ default: module.SettingsWolPage })),
)
const SettingsHttpsPage = lazyPage(() =>
  import('./pages/SettingsHttpsPage').then((module) => ({ default: module.SettingsHttpsPage })),
)
const SettingsTagsPage = lazyPage(() =>
  import('./pages/SettingsTagsPage').then((module) => ({ default: module.SettingsTagsPage })),
)
const SettingsCategoriesPage = lazyPage(() =>
  import('./pages/SettingsCategoriesPage').then((module) => ({ default: module.SettingsCategoriesPage })),
)
const ServiceRequestsPage = lazyPage(() =>
  import('./pages/ServiceRequestsPage').then((module) => ({ default: module.ServiceRequestsPage })),
)
const UsersPage = lazyPage(() => import('./pages/UsersPage').then((module) => ({ default: module.UsersPage })))
const SettingsBitrix24Page = lazyPage(() =>
  import('./pages/SettingsBitrix24Page').then((module) => ({ default: module.SettingsBitrix24Page })),
)
const SettingsZabbixPage = lazyPage(() =>
  import('./pages/SettingsZabbixPage').then((module) => ({ default: module.SettingsZabbixPage })),
)
const SettingsDatabasePage = lazyPage(() =>
  import('./pages/SettingsDatabasePage').then((module) => ({ default: module.SettingsDatabasePage })),
)
const SettingsGlpiPage = lazyPage(() =>
  import('./pages/SettingsGlpiPage').then((module) => ({ default: module.SettingsGlpiPage })),
)
const SettingsLlmPage = lazyPage(() =>
  import('./pages/SettingsLlmPage').then((module) => ({ default: module.SettingsLlmPage })),
)
const KnowledgeSitemapPage = lazyPage(() =>
  import('./pages/KnowledgeSitemapPage').then((module) => ({ default: module.KnowledgeSitemapPage })),
)
const WikiRagPage = lazyPage(() =>
  import('./pages/WikiRagPage').then((module) => ({ default: module.WikiRagPage })),
)
const NotesPage = lazyPage(() => import('./pages/NotesPage').then((module) => ({ default: module.NotesPage })))
const KnowledgeZabbixPage = lazyPage(() =>
  import('./pages/KnowledgeZabbixPage').then((module) => ({ default: module.KnowledgeZabbixPage })),
)
const WarehousePage = lazyPage(() =>
  import('./pages/WarehousePage').then((module) => ({ default: module.WarehousePage })),
)
const PrintersPage = lazyPage(() =>
  import('./pages/PrintersPage').then((module) => ({ default: module.PrintersPage })),
)
const NetworkPage = lazyPage(() =>
  import('./pages/NetworkPage').then((module) => ({ default: module.NetworkPage })),
)
const NetworkMapPage = lazyPage(() =>
  import('./pages/NetworkMapPage').then((module) => ({ default: module.NetworkMapPage })),
)
const TicketHandlerClientPage = lazyPage(() =>
  import('./pages/TicketHandlerClientPage').then((module) => ({ default: module.TicketHandlerClientPage })),
)
const GuidePage = lazyPage(() => import('./pages/GuidePage').then((module) => ({ default: module.GuidePage })))
const AssistSessionPage = lazyPage(() =>
  import('./pages/AssistSessionPage').then((module) => ({ default: module.AssistSessionPage })),
)

function DocumentTitle() {
  const { pathname, search } = useLocation()
  const { locale } = useLocale()
  useEffect(() => {
    if (pathname === '/h' || pathname === '/r') return
    const base = titleForPath(pathname, locale)
    if (pathname.startsWith('/assist')) {
      const host = new URLSearchParams(search).get('host')
      document.title = host ? `${base} · ${host}` : base
      return
    }
    document.title = base
  }, [pathname, search, locale])
  return null
}

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return <PageLoader />
  }
  if (!user) {
    return <Navigate to="/login" replace />
  }
  if (user.must_change_password) {
    return <ForceChangePasswordPage />
  }
  return children
}

function LegacySelfServiceRedirect() {
  const { hash } = useLocation()
  return <Navigate to={legacySelfServiceLocation(hash)} replace />
}

function PreserveSearchRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${to}${search}${hash}`} replace />
}

function PageLoader() {
  const { t } = useLocale()
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-[var(--color-bg)]">
      <div
        className="h-10 w-10 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-primary)]"
        aria-hidden
      />
      <span className="text-sm font-medium text-[var(--color-fg-subtle)]">{t('common.loading')}</span>
    </div>
  )
}

export default function App() {
  return (
    <>
      <DocumentTitle />
      <Suspense fallback={<PageLoader />}>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/r" element={<LegacySelfServiceRedirect />} />
      <Route path="/h" element={<TicketHandlerClientPage />} />
      <Route
        path="/assist/:sessionId"
        element={
          <Protected>
            <AssistSessionPage />
          </Protected>
        }
      />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="risks" element={<RiskCenterPage />} />
        <Route path="software" element={<SoftwarePage />} />
        <Route path="computers" element={<ComputersPage />} />
        <Route path="server-audit" element={<ServerAuditPage />} />
        <Route path="printers" element={<PrintersPage />} />
        <Route path="network" element={<NetworkPage />} />
        <Route path="network-map" element={<NetworkMapPage />} />
        <Route path="requests/handler" element={<Navigate to="/requests/database" replace />} />
        <Route path="requests" element={<ServiceRequestsPage />}>
          <Route index element={<PreserveSearchRedirect to="/requests/database" />} />
          <Route path="database" element={null} />
          <Route path="stats" element={null} />
          <Route path="templates" element={null} />
        </Route>
        <Route path="users" element={<UsersPage />} />
        <Route path="settings" element={<SettingsIndexPage />} />
        <Route path="settings/tags" element={<SettingsTagsPage />} />
        <Route path="settings/categories" element={<SettingsCategoriesPage />} />
        <Route path="settings/ldap" element={<SettingsLdapPage />} />
        <Route path="settings/bitrix24" element={<SettingsBitrix24Page />} />
        <Route path="settings/zabbix" element={<SettingsZabbixPage />} />
        <Route path="settings/database" element={<SettingsDatabasePage />} />
        <Route path="settings/glpi" element={<SettingsGlpiPage />} />
        <Route path="settings/llm" element={<SettingsLlmPage />} />
        <Route path="settings/agent-tokens" element={<AgentTokensPage />} />
        <Route path="settings/agent-bundle" element={<AgentBundlePage />} />
        <Route path="settings/wol" element={<SettingsWolPage />} />
        <Route path="settings/https" element={<SettingsHttpsPage />} />
        <Route path="knowledge-base" element={<Navigate to="/knowledge-base/wikirag" replace />} />
        <Route path="knowledge-base/sitemap" element={<KnowledgeSitemapPage />} />
        <Route path="knowledge-base/guide" element={<GuidePage />} />
        <Route path="knowledge-base/wikirag" element={<WikiRagPage />} />
        <Route path="knowledge-base/notes" element={<NotesPage />} />
        <Route path="knowledge-base/zabbix" element={<KnowledgeZabbixPage />} />
        <Route path="knowledge-base/warehouse" element={<Navigate to="/warehouse" replace />} />
        <Route path="warehouse" element={<WarehousePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </Suspense>
    </>
  )
}
