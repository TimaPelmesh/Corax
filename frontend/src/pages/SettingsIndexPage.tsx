import { Link } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { IconSettings } from '../components/icons'
import { buildNavSections } from '../components/layout/navConfig'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'

export function SettingsIndexPage() {
  const t = useT()
  const { user } = useAuth()
  const section = buildNavSections(user).find((s) => s.titleKey === 'nav.settings')
  const items = section?.items ?? []

  return (
    <div>
      <PageHeader
        icon={<IconSettings className="h-6 w-6" />}
        title={t('titles.settings')}
        subtitle={t('pages.settingsSubtitle')}
      />
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3.5 no-underline shadow-sm transition hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
            >
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-[var(--color-fg)]">{t(item.labelKey)}</span>
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
