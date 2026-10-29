import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type SettingsBoardItem } from '../api'
import { useAuth } from '../AuthContext'
import { buildNavSections } from '../components/layout/navConfig'
import { StatusPill, type StatusPillTone } from '../components/ui/StatusPill'
import { useT, type MessageKey } from '../i18n/LocaleContext'

const STATE_TONE: Record<SettingsBoardItem['state'], StatusPillTone> = {
  ok: 'success',
  error: 'error',
  stale: 'warning',
  off: 'neutral',
  local: 'info',
}

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
  const [board, setBoard] = useState<Record<string, SettingsBoardItem>>({})

  useEffect(() => {
    let cancelled = false
    void api
      .settingsBoard()
      .then((payload) => {
        if (cancelled) return
        const next: Record<string, SettingsBoardItem> = {}
        for (const row of payload.items) next[row.path] = row
        setBoard(next)
      })
      .catch(() => {
        if (!cancelled) setBoard({})
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="settings-page settings-page--wide">
      <h1 className="sr-only">{t('titles.settings')}</h1>
      <p className="text-sm text-[var(--color-fg-muted)]">{t('pages.settingsSubtitle')}</p>
      <div className="grid gap-2 lg:grid-cols-2">
        {items.map((item) => {
          const Icon = item.icon
          const purposeKey = PURPOSE_KEY[item.to]
          const status = board[item.to]
          const codeKey = status ? (`settingsBoard.${status.code}` as MessageKey) : null
          return (
            <Link
              key={item.to}
              to={item.to}
              className="app-card flex items-center gap-3 px-3 py-2.5 no-underline hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-[var(--color-fg)]">{t(item.labelKey)}</span>
                {purposeKey ? (
                  <span className="block truncate text-[13px] text-[var(--color-fg-muted)]">{t(purposeKey)}</span>
                ) : null}
              </span>
              {status && codeKey ? (
                <StatusPill tone={STATE_TONE[status.state]} className="max-w-[11rem] truncate">
                  {t(codeKey, { count: status.count })}
                </StatusPill>
              ) : null}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
