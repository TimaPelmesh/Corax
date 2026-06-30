import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { ComputersPage } from './pages/ComputersPage'
import { DashboardPage } from './pages/DashboardPage'
import { SoftwarePage } from './pages/SoftwarePage'
import { Layout } from './pages/Layout'
import { LoginPage } from './pages/LoginPage'
import { AgentTokensPage } from './pages/AgentTokensPage'
import { AgentBundlePage } from './pages/AgentBundlePage'
import { SettingsLdapPage } from './pages/SettingsLdapPage'
import { SettingsTagsPage } from './pages/SettingsTagsPage'
import { SettingsCategoriesPage } from './pages/SettingsCategoriesPage'
import { ServiceRequestsPage } from './pages/ServiceRequestsPage'
import { UsersPage } from './pages/UsersPage'
import { SettingsBitrix24Page } from './pages/SettingsBitrix24Page'
import { SettingsDatabasePage } from './pages/SettingsDatabasePage'
import { SettingsGlpiPage } from './pages/SettingsGlpiPage'
import { KnowledgeSitemapPage } from './pages/KnowledgeSitemapPage'
import { WikiRagPage } from './pages/WikiRagPage'
import { WarehousePage } from './pages/WarehousePage'
import { PrintersPage } from './pages/PrintersPage'

function Protected({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-white">
        <div
          className="h-10 w-10 animate-spin rounded-full border-2 border-neutral-200 border-t-red-600"
          aria-hidden
        />
        <span className="text-sm font-medium text-neutral-500">Загрузка…</span>
      </div>
    )
  }
  if (!user) {
    return <Navigate to="/login" replace />
  }
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="software" element={<SoftwarePage />} />
        <Route path="computers" element={<ComputersPage />} />
        <Route path="printers" element={<PrintersPage />} />
        <Route path="requests" element={<ServiceRequestsPage />} />
        <Route path="requests/database" element={<ServiceRequestsPage />} />
        <Route path="requests/stats" element={<ServiceRequestsPage />} />
        <Route path="requests/templates" element={<ServiceRequestsPage />} />
        <Route path="users" element={<UsersPage />} />
        <Route path="settings/tags" element={<SettingsTagsPage />} />
        <Route path="settings/categories" element={<SettingsCategoriesPage />} />
        <Route path="settings/ldap" element={<SettingsLdapPage />} />
        <Route path="settings/bitrix24" element={<SettingsBitrix24Page />} />
        <Route path="settings/database" element={<SettingsDatabasePage />} />
        <Route path="settings/glpi" element={<SettingsGlpiPage />} />
        <Route path="settings/agent-tokens" element={<AgentTokensPage />} />
        <Route path="settings/agent-bundle" element={<AgentBundlePage />} />
        <Route path="knowledge-base" element={<Navigate to="/knowledge-base/sitemap" replace />} />
        <Route path="knowledge-base/sitemap" element={<KnowledgeSitemapPage />} />
        <Route path="knowledge-base/wikirag" element={<WikiRagPage />} />
        <Route path="knowledge-base/warehouse" element={<WarehousePage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
