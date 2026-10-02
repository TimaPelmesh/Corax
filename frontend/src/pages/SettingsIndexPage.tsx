import { Link } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { buildNavSections } from '../components/layout/navConfig'
import { useT, type MessageKey } from '../i18n/LocaleContext'

const PURPOSE_KEY: Record<string, MessageKey> = {
  '/settings/llm': 'settingsPurpose.llm',
  '/settings/tags': 'settingsPurpose.tags',
  '/settings/categories': 'settingsPurpose.categories',
  '/users': 'settingsPurpose.users',
  '/settings/ldap': 'settingsPurpose.ldap',
  '/settings/bitrix24': 'settingsPurpose.bitrix24',
  '/settings/zabbix': 'settingsPurpose.zabbix',
  '/settings/database': 'settingsPurpose.database',
  '/settings/glpi': 'settingsPurpose.glpi',
  '/settings/agent-tokens': 'settingsPurpose.agentTokens',
  '/settings/agent-bundle': 'settingsPurpose.agentBundle',
  '/settings/wol': 'settingsPurpose.wol',
  '/settings/https': 'settingsPurpose.https',
}

export function SettingsIndexPage() {
  const t = useT()
  const { user } = useAuth()
  const section = buildNavSections(user).find((s) => s.titleKey === 'nav.settings')
  const items = section?.items ?? []

  return (
    <div>
      <h1 className="page-title">{t('titles.settings')}</h1>
      <p className="mt-1 max-w-xl text-sm text-[var(--color-fg-muted)]">{t('pages.settingsSubtitle')}</p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon
          const purposeKey = PURPOSE_KEY[item.to]
          return (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 no-underline shadow-[var(--shadow-card)] transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--color-fg)]">{t(item.labelKey)}</span>
                {purposeKey ? (
                  <span className="mt-1 block text-[13px] leading-snug text-[var(--color-fg-muted)]">{t(purposeKey)}</span>
                ) : null}
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
