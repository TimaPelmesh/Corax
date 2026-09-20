import { useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type ZabbixConfig, type ZabbixTestResult } from '../api'
import { useAuth } from '../AuthContext'
import { IconZabbix } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function SettingsZabbixPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [cfg, setCfg] = useState<ZabbixConfig | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [verifyTls, setVerifyTls] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [lastTest, setLastTest] = useState<ZabbixTestResult | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await api.zabbixConfig()
      setCfg(next)
      setBaseUrl(next.base_url || '')
      setApiToken('')
      setEnabled(Boolean(next.enabled))
      setVerifyTls(next.verify_tls !== false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsZabbix.loadFailed'))
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const urlLooksHttp = useMemo(() => {
    const u = baseUrl.trim().toLowerCase()
    return u.startsWith('http://') || (!u.startsWith('https://') && u.length > 0)
  }, [baseUrl])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  async function save() {
    setSaving(true)
    try {
      const patch: Parameters<typeof api.updateZabbixConfig>[0] = {
        enabled,
        base_url: baseUrl.trim(),
        verify_tls: verifyTls,
      }
      if (apiToken.trim()) patch.api_token = apiToken.trim()
      const next = await api.updateZabbixConfig(patch)
      setCfg(next)
      setApiToken('')
      toast.ok(t('settingsZabbix.saveSuccess'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsZabbix.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function testConnection() {
    setTesting(true)
    try {
      const patch: Parameters<typeof api.updateZabbixConfig>[0] = {
        enabled,
        base_url: baseUrl.trim(),
        verify_tls: verifyTls,
      }
      if (apiToken.trim()) patch.api_token = apiToken.trim()
      const saved = await api.updateZabbixConfig(patch)
      setCfg(saved)
      setApiToken('')
      const result = await api.zabbixTest()
      setLastTest(result)
      setCfg(await api.zabbixConfig())
      if (result.ok) toast.ok(result.message || t('settingsZabbix.testOk'))
      else toast.error(result.message || t('settingsZabbix.testFailed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsZabbix.testFailed'))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        icon={<IconZabbix className="h-6 w-6" />}
        title={t('titles.zabbix')}
        subtitle={t('pages.zabbixSubtitle')}
      />

      {!cfg ? (
        <div className="app-card p-6 text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</div>
      ) : (
        <>
          <div className="app-card space-y-4 p-6 sm:p-7">
            <p className="text-sm text-[var(--color-fg-muted)]">{t('settingsZabbix.scopeHint')}</p>
            <p className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)]/60 px-3 py-2 text-xs text-[var(--color-fg-muted)]">
              {t('settingsZabbix.httpHint')}
            </p>

            <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t('settingsZabbix.enabled')}
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">
                {t('settingsZabbix.baseUrl')}
              </span>
              <input
                className="app-input w-full"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://192.168.1.10/zabbix"
                autoComplete="off"
              />
              <span className="mt-1 block text-[11px] text-[var(--color-fg-subtle)]">
                {t('settingsZabbix.baseUrlHint')}
              </span>
            </label>

            <label className="block text-sm">
              <span className="mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]">
                {t('settingsZabbix.apiToken')}
              </span>
              <input
                type="password"
                className="app-input w-full"
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder={
                  cfg.api_token_set ? t('settingsZabbix.apiTokenSet') : t('settingsZabbix.apiTokenPlaceholder')
                }
                autoComplete="new-password"
              />
            </label>

            <label
              className={`flex items-center gap-2 text-sm ${urlLooksHttp ? 'text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]'}`}
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={verifyTls}
                disabled={urlLooksHttp}
                onChange={(e) => setVerifyTls(e.target.checked)}
              />
              {t('settingsZabbix.verifyTls')}
              {urlLooksHttp ? (
                <span className="text-[11px]">({t('settingsZabbix.verifyTlsHttpNA')})</span>
              ) : null}
            </label>

            <div className="flex flex-wrap gap-2">
              <button type="button" className="app-btn app-btn-primary" disabled={saving} onClick={() => void save()}>
                {saving ? t('settingsZabbix.saving') : t('common.save')}
              </button>
              <button
                type="button"
                className="app-btn app-btn-secondary"
                disabled={testing}
                onClick={() => void testConnection()}
              >
                {testing ? t('settingsZabbix.testing') : t('settingsZabbix.test')}
              </button>
            </div>

            {lastTest || cfg.last_test_message ? (
              <div
                className={`rounded-lg border px-3 py-2 text-sm ${
                  (lastTest?.ok ?? cfg.last_test_ok)
                    ? 'border-sky-500/25 bg-sky-500/[0.07] text-[var(--color-fg)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 text-[var(--color-fg-muted)]'
                }`}
              >
                <div className="font-medium">{lastTest?.message || cfg.last_test_message}</div>
                {(lastTest?.version || cfg.last_version) ? (
                  <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
                    {t('settingsZabbix.version')}: {lastTest?.version || cfg.last_version}
                    {(lastTest?.hosts_total ?? cfg.last_hosts_total) != null
                      ? ` · ${t('settingsZabbix.hosts')}: ${lastTest?.hosts_total ?? cfg.last_hosts_total}`
                      : ''}
                    {(lastTest?.problems_total ?? cfg.last_problems_total) != null
                      ? ` · ${t('settingsZabbix.problems')}: ${lastTest?.problems_total ?? cfg.last_problems_total}`
                      : ''}
                  </div>
                ) : null}
                {lastTest?.api_url ? (
                  <div className="mt-1 break-all font-mono text-[11px] text-[var(--color-fg-subtle)]">
                    {lastTest.scheme?.toUpperCase()} · {lastTest.auth_mode} · {lastTest.api_url}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="app-card space-y-2 p-6 sm:p-7">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {t('settingsZabbix.nextTitle')}
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--color-fg-muted)]">
              <li>{t('settingsZabbix.nextDone')}</li>
              <li>{t('settingsZabbix.nextC')}</li>
              <li>{t('settingsZabbix.nextWiki')}</li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
