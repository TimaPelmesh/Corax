import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { titleForPath } from './documentTitle'
import { useLocale } from './i18n/LocaleContext'
import { legacySelfServiceLocation } from './lib/helpdeskRedirect'
import { LoginPage } from './pages/LoginPage'

const ForceChangePasswordPage = lazy(() =>
  import('./pages/ForceChangePasswordPage').then((module) => ({ default: module.ForceChangePasswordPage })),
)
const Layout = lazy(() => import('./pages/Layout').then((module) => ({ default: module.Layout })))
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({ default: module.DashboardPage })),
)
const RiskCenterPage = lazy(() =>
  import('./pages/RiskCenterPage').then((module) => ({ default: module.RiskCenterPage })),
)
const ComputersPage = lazy(() =>
  import('./pages/ComputersPage').then((module) => ({ default: module.ComputersPage })),
)
const SoftwarePage = lazy(() =>
  import('./pages/SoftwarePage').then((module) => ({ default: module.SoftwarePage })),
)
const AgentTokensPage = lazy(() =>
  import('./pages/AgentTokensPage').then((module) => ({ default: module.AgentTokensPage })),
)
const AgentBundlePage = lazy(() =>
  import('./pages/AgentBundlePage').then((module) => ({ default: module.AgentBundlePage })),
)
const SettingsIndexPage = lazy(() =>
  import('./pages/SettingsIndexPage').then((module) => ({ default: module.SettingsIndexPage })),
)
const SettingsLdapPage = lazy(() =>
  import('./pages/SettingsLdapPage').then((module) => ({ default: module.SettingsLdapPage })),
)
const SettingsWolPage = lazy(() =>
  import('./pages/SettingsWolPage').then((module) => ({ default: module.SettingsWolPage })),
)
const SettingsHttpsPage = lazy(() =>
  import('./pages/SettingsHttpsPage').then((module) => ({ default: module.SettingsHttpsPage })),
)
const SettingsTagsPage = lazy(() =>
  import('./pages/SettingsTagsPage').then((module) => ({ default: module.SettingsTagsPage })),
)
const SettingsCategoriesPage = lazy(() =>
  import('./pages/SettingsCategoriesPage').then((module) => ({ default: module.SettingsCategoriesPage })),
)
const ServiceRequestsPage = lazy(() =>
  import('./pages/ServiceRequestsPage').then((module) => ({ default: module.ServiceRequestsPage })),
)
const UsersPage = lazy(() => import('./pages/UsersPage').then((module) => ({ default: module.UsersPage })))
const SettingsBitrix24Page = lazy(() =>
  import('./pages/SettingsBitrix24Page').then((module) => ({ default: module.SettingsBitrix24Page })),
)
const SettingsZabbixPage = lazy(() =>
  import('./pages/SettingsZabbixPage').then((module) => ({ default: module.SettingsZabbixPage })),
)
const SettingsDatabasePage = lazy(() =>
  import('./pages/SettingsDatabasePage').then((module) => ({ default: module.SettingsDatabasePage })),
)
const SettingsGlpiPage = lazy(() =>
  import('./pages/SettingsGlpiPage').then((module) => ({ default: module.SettingsGlpiPage })),
)
const SettingsLlmPage = lazy(() =>
  import('./pages/SettingsLlmPage').then((module) => ({ default: module.SettingsLlmPage })),
)
const KnowledgeSitemapPage = lazy(() =>
  import('./pages/KnowledgeSitemapPage').then((module) => ({ default: module.KnowledgeSitemapPage })),
)
const WikiRagPage = lazy(() =>
  import('./pages/WikiRagPage').then((module) => ({ default: module.WikiRagPage })),
)
const NotesPage = lazy(() => import('./pages/NotesPage').then((module) => ({ default: module.NotesPage })))
const KnowledgeZabbixPage = lazy(() =>
  import('./pages/KnowledgeZabbixPage').then((module) => ({ default: module.KnowledgeZabbixPage })),
)
const WarehousePage = lazy(() =>
  import('./pages/WarehousePage').then((module) => ({ default: module.WarehousePage })),
)
const PrintersPage = lazy(() =>
  import('./pages/PrintersPage').then((module) => ({ default: module.PrintersPage })),
)
const NetworkPage = lazy(() =>
  import('./pages/NetworkPage').then((module) => ({ default: module.NetworkPage })),
)
const NetworkMapPage = lazy(() =>
  import('./pages/NetworkMapPage').then((module) => ({ default: module.NetworkMapPage })),
)
const TicketHandlerClientPage = lazy(() =>
  import('./pages/TicketHandlerClientPage').then((module) => ({ default: module.TicketHandlerClientPage })),
)
const GuidePage = lazy(() => import('./pages/GuidePage').then((module) => ({ default: module.GuidePage })))

function DocumentTitle() {
  const { pathname } = useLocation()
  const { locale } = useLocale()
  useEffect(() => {
    document.title = titleForPath(pathname, locale)
  }, [pathname, locale])
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
        <Route path="printers" element={<PrintersPage />} />
        <Route path="network" element={<NetworkPage />} />
        <Route path="network-map" element={<NetworkMapPage />} />
        <Route path="requests/handler" element={<Navigate to="/requests/database" replace />} />
        <Route path="requests" element={<ServiceRequestsPage />}>
          <Route index element={null} />
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
        <Route path="knowledge-base" element={<Navigate to="/knowledge-base/sitemap" replace />} />
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
