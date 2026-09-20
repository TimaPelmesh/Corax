import { useLocale } from '../i18n/LocaleContext'
import { useApiHealth } from '../hooks/useApiHealth'

export function ApiOfflineBanner() {
  const { t } = useLocale()
  const online = useApiHealth()
  if (online) return null
  return (
    <div
      className="border-b border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-4 py-2 text-sm text-[var(--color-warning-fg)] sm:px-6"
      role="status"
    >
      <p className="font-semibold">{t('chrome.offlineTitle')}</p>
      <p className="mt-0.5 text-[13px] leading-relaxed opacity-90">{t('chrome.offlineBody')}</p>
    </div>
  )
}
