import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type LdapConfig, type LdapSyncResult, type User } from '../api'
import { useAuth } from '../AuthContext'
import { IconKey } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function fieldTrim(v: string) {
  return v.replace(/\s+/g, ' ').trim()
}

export function SettingsLdapPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<LdapSyncResult | null>(null)
  const [users, setUsers] = useState<User[]>([])

  const [loaded, setLoaded] = useState<LdapConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [allowAnonymous, setAllowAnonymous] = useState(false)
  const [uri, setUri] = useState('')
  const [bindDn, setBindDn] = useState('')
  const [bindPassword, setBindPassword] = useState('')
  const [userSearchBase, setUserSearchBase] = useState('')
  const [userFilter, setUserFilter] = useState('(&(objectClass=user)(objectCategory=person))')
  const [usernameAttr, setUsernameAttr] = useState('sAMAccountName')
  const [displayNameAttr, setDisplayNameAttr] = useState('displayName')
  const [emailAttr, setEmailAttr] = useState('mail')
  const [syncLimit, setSyncLimit] = useState(500)
  const [probeUsername, setProbeUsername] = useState('')

  const bindPasswordSet = loaded?.bind_password_set ?? false

  const configured = useMemo(() => {
    if (!enabled) return false
    if (!fieldTrim(uri) || !fieldTrim(userSearchBase)) return false
    if (allowAnonymous) return true
    const pSet = bindPassword.trim().length > 0 || bindPasswordSet
    return Boolean(fieldTrim(bindDn) && pSet)
  }, [enabled, allowAnonymous, uri, bindDn, bindPassword, bindPasswordSet, userSearchBase])
  const ldapUsers = useMemo(() => users.filter((u) => u.is_ldap), [users])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [cfg, usersRows] = await Promise.all([api.ldapConfig(), api.users()])
      setLoaded(cfg)
      setUsers(usersRows)
      setEnabled(Boolean(cfg.enabled))
      setAllowAnonymous(Boolean(cfg.allow_anonymous))
      setUri(cfg.uri ?? '')
      setBindDn(cfg.bind_dn ?? '')
      setBindPassword('')
      setUserSearchBase(cfg.user_search_base ?? '')
      setUserFilter(cfg.user_filter ?? '(&(objectClass=user)(objectCategory=person))')
      setUsernameAttr(cfg.username_attr ?? 'sAMAccountName')
      setDisplayNameAttr(cfg.display_name_attr ?? 'displayName')
      setEmailAttr(cfg.email_attr ?? 'mail')
      setSyncLimit(cfg.sync_limit ?? 500)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  async function onSave(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    try {
      const body = {
        enabled,
        allow_anonymous: allowAnonymous,
        uri: fieldTrim(uri),
        bind_dn: fieldTrim(bindDn),
        bind_password: bindPassword === '' ? null : bindPassword, // null => keep current
        user_search_base: fieldTrim(userSearchBase),
        user_filter: userFilter.trim() || '(&(objectClass=user)(objectCategory=person))',
        username_attr: usernameAttr.trim() || 'sAMAccountName',
        display_name_attr: displayNameAttr.trim() || 'displayName',
        email_attr: emailAttr.trim() || 'mail',
        sync_limit: Number.isFinite(syncLimit) ? syncLimit : 500,
      } as const
      const cfg = await api.updateLdapConfig(body)
      setLoaded(cfg)
      setBindPassword('')
      toast.ok(
        t('settingsLdap.saveSummary', {
          uri: cfg.uri || '—',
          baseDn: cfg.user_search_base || '—',
          bindDn: cfg.bind_dn || '—',
          passwordStatus: cfg.bind_password_set
            ? t('settingsLdap.passwordSaved')
            : t('settingsLdap.passwordMissing'),
        }),
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  async function onTestBind() {
    if (!allowAnonymous && !bindPassword.trim() && !bindPasswordSet) {
      toast.error(t('settingsLdap.bindPasswordMissing'))
      return
    }
    setTesting(true)
    setSyncResult(null)
    try {
      const r = await api.testLdapConfig({
        allow_anonymous: allowAnonymous,
        uri: fieldTrim(uri) || undefined,
        bind_dn: fieldTrim(bindDn) || undefined,
        bind_password: bindPassword.trim() || undefined,
        user_search_base: fieldTrim(userSearchBase) || undefined,
        user_filter: userFilter.trim() || undefined,
        username_attr: usernameAttr.trim() || undefined,
        display_name_attr: displayNameAttr.trim() || undefined,
        email_attr: emailAttr.trim() || undefined,
        probe_username: null,
      })
      toast.info(r.ok ? r.message : t('settingsLdap.testFailed'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setTesting(false)
    }
  }

  async function onTestSearch() {
    const probe = fieldTrim(probeUsername)
    if (!probe) return
    if (!allowAnonymous && !bindPassword.trim() && !bindPasswordSet) {
      toast.error(t('settingsLdap.bindPasswordMissing'))
      return
    }
    setTesting(true)
    setSyncResult(null)
    try {
      const r = await api.testLdapConfig({
        allow_anonymous: allowAnonymous,
        uri: fieldTrim(uri) || undefined,
        bind_dn: fieldTrim(bindDn) || undefined,
        bind_password: bindPassword.trim() || undefined,
        user_search_base: fieldTrim(userSearchBase) || undefined,
        user_filter: userFilter.trim() || undefined,
        username_attr: usernameAttr.trim() || undefined,
        display_name_attr: displayNameAttr.trim() || undefined,
        email_attr: emailAttr.trim() || undefined,
        probe_username: probe,
      })
      toast.info(
        t('settingsLdap.testSearchResult', {
          message: r.message,
          found: r.found,
          sampleDn: r.sample_dn ? t('settingsLdap.sampleDn', { dn: r.sample_dn }) : '',
        }),
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconKey className="h-7 w-7 text-blue-600" />
        </div>
        <div className="min-w-0">
          <h1 className="page-title">{t('titles.ldap')}</h1>
          <p className="mt-1 max-w-2xl text-slate-600">
            {t('pages.ldapSubtitle')}
          </p>
        </div>
      </div>

      {syncResult ? (
        <div className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800">
          <div className="font-medium">
            {t('settingsLdap.syncSummary', {
              created: syncResult.created_count,
              skipped: syncResult.skipped_count,
            })}
          </div>
          {typeof syncResult.scanned_count === 'number' || typeof syncResult.missing_username_attr === 'number' ? (
            <div className="mt-1 text-xs text-slate-600">
              {typeof syncResult.scanned_count === 'number' ? (
                <>{t('settingsLdap.syncScanned', { count: syncResult.scanned_count })} </>
              ) : null}
              {typeof syncResult.missing_username_attr === 'number' ? (
                <>
                  {t('settingsLdap.syncMissingUsernameAttr', {
                    attr: usernameAttr || 'username',
                    count: syncResult.missing_username_attr,
                  })}
                </>
              ) : null}
            </div>
          ) : null}
          {syncResult.entries.length ? (
            <div className="mt-2 max-h-40 overflow-y-auto rounded-lg bg-slate-50 p-3 font-mono text-xs text-slate-700">
              {syncResult.entries.slice(0, 200).map((e) => (
                <div key={`${e.username}-${String(e.created)}`}>
                  {e.username}
                  {e.created && e.one_time_password ? (
                    <span className="text-neutral-900">
                      {t('settingsLdap.entryPassword')}
                      <strong>{e.one_time_password}</strong>
                    </span>
                  ) : (
                    <span className="text-slate-500">{t('settingsLdap.entryExists')}</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <form onSubmit={onSave} className="app-card max-w-3xl space-y-4 p-6 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            {t('settingsLdap.enable')}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              checked={allowAnonymous}
              onChange={(e) => setAllowAnonymous(e.target.checked)}
            />
            {t('settingsLdap.anonymousBind')}
          </label>
          <div className="text-xs font-medium text-slate-500">
            {t('settingsLdap.statusLabel')}{' '}
            {configured ? (
              <span className="text-emerald-700">{t('settingsLdap.configured')}</span>
            ) : (
              <span>{t('settingsLdap.notConfigured')}</span>
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-500">{t('settingsLdap.ldapUriLabel')}</label>
            <input
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder={t('settingsLdap.ldapUriPlaceholder')}
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{t('settingsLdap.bindDnLabel')}</label>
            <input
              value={bindDn}
              onChange={(e) => setBindDn(e.target.value)}
              placeholder={t('settingsLdap.bindDnPlaceholder')}
              disabled={allowAnonymous}
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">{t('settingsLdap.bindPasswordLabel')}</label>
            <input
              type="password"
              value={bindPassword}
              onChange={(e) => setBindPassword(e.target.value)}
              placeholder={
                bindPasswordSet
                  ? t('settingsLdap.bindPasswordPlaceholderSet')
                  : t('settingsLdap.bindPasswordPlaceholderUnset')
              }
              disabled={allowAnonymous}
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
            <p className="mt-1 text-xs text-slate-500">
              {allowAnonymous ? (
                <>{t('settingsLdap.anonymousBindHint')}</>
              ) : (
                <>{t('settingsLdap.keepPasswordHint')}</>
              )}
            </p>
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {t('settingsLdap.userSearchBaseLabel')}
            </label>
            <input
              value={userSearchBase}
              onChange={(e) => setUserSearchBase(e.target.value)}
              placeholder={t('settingsLdap.userSearchBasePlaceholder')}
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {t('settingsLdap.userFilterLabel')}
            </label>
            <input
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              placeholder="(&(objectClass=user)(objectCategory=person))"
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 font-mono text-xs text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {t('settingsLdap.usernameAttrLabel')}
            </label>
            <input
              value={usernameAttr}
              onChange={(e) => setUsernameAttr(e.target.value)}
              placeholder="sAMAccountName"
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 font-mono text-xs text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {t('settingsLdap.syncLimitLabel')}
            </label>
            <input
              type="number"
              value={syncLimit}
              onChange={(e) => setSyncLimit(Number(e.target.value))}
              min={1}
              max={5000}
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {t('settingsLdap.displayNameAttrLabel')}
            </label>
            <input
              value={displayNameAttr}
              onChange={(e) => setDisplayNameAttr(e.target.value)}
              placeholder="displayName"
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 font-mono text-xs text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-500">
              {t('settingsLdap.emailAttrLabel')}
            </label>
            <input
              value={emailAttr}
              onChange={(e) => setEmailAttr(e.target.value)}
              placeholder="mail"
              className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 font-mono text-xs text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-2">
          <button
            type="submit"
            disabled={saving || loading}
            className="app-btn app-btn-primary"
          >
            {saving ? t('settingsLdap.saveBusy') : t('common.save')}
          </button>
          <button
            type="button"
            disabled={testing || loading}
            onClick={() => void onTestBind()}
            className="app-btn app-btn-secondary"
          >
            {testing ? t('settingsLdap.testBusy') : t('settingsLdap.testBind')}
          </button>
          <button
            type="button"
            disabled={syncing || loading || !configured}
            onClick={() => {
              void (async () => {
                setSyncing(true)
                setSyncResult(null)
                try {
                  const r = await api.ldapSync()
                  setSyncResult(r)
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : t('common.error'))
                } finally {
                  setSyncing(false)
                }
              })()
            }}
            className="app-btn app-btn-secondary"
            title={!configured ? t('settingsLdap.syncDisabledTitle') : t('settingsLdap.syncEnabledTitle')}
          >
            {syncing ? t('settingsLdap.syncBusy') : t('settingsLdap.syncUsers')}
          </button>
          <div className="min-w-[14rem] flex-1" />
          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            <div className="min-w-0 flex-1 sm:w-[16rem]">
              <label className="mb-1 block text-xs font-medium text-slate-500">
                {t('settingsLdap.probeSearchLabel')}
              </label>
              <input
                value={probeUsername}
                onChange={(e) => setProbeUsername(e.target.value)}
                placeholder="jdoe"
                className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <button
              type="button"
              disabled={testing || loading || !probeUsername.trim()}
              onClick={() => void onTestSearch()}
              className="app-btn app-btn-secondary"
            >
              {t('settingsLdap.probeSearchButton')}
            </button>
          </div>
        </div>

        {loading ? <p className="text-sm text-slate-500">{t('common.loading')}</p> : null}
      </form>

      <div className="app-card mt-6 overflow-hidden p-0">
        <div className="border-b border-neutral-200 px-4 py-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">
            {t('settingsLdap.ldapUsersTitle')}
          </h2>
        </div>
        <div className="overflow-x-auto overscroll-x-contain">
          <table className="min-w-[560px] w-full text-left text-sm">
            <thead className="app-table-head">
              <tr>
                <th className="px-4 py-3">{t('settingsLdap.tableId')}</th>
                <th className="px-4 py-3">{t('settingsLdap.tableUsername')}</th>
                <th className="px-4 py-3">{t('settingsLdap.tableFullName')}</th>
                <th className="px-4 py-3">{t('settingsLdap.tableRole')}</th>
                <th className="px-4 py-3">{t('settingsLdap.tableStatus')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {ldapUsers.map((u) => (
                <tr key={u.id} className="app-table-row">
                  <td className="px-4 py-3 font-mono text-slate-500">{u.id}</td>
                  <td className="px-4 py-3 font-medium text-slate-900">{u.username}</td>
                  <td className="px-4 py-3 text-slate-600">{u.full_name ?? '—'}</td>
                  <td className="px-4 py-3">
                    {u.is_superuser ? (
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-medium text-neutral-900">
                        {t('settingsLdap.adminRole')}
                      </span>
                    ) : (
                      <span className="text-slate-600">{u.role}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {u.is_active ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
                        {t('settingsLdap.statusActive')}
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
                        {t('settingsLdap.statusInactive')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

