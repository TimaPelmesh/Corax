import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, type User, type WolConfig } from '../api'
import { useAuth } from '../AuthContext'
import { IconPcs } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function normalizeWolConfig(c: WolConfig): WolConfig {
  return {
    enabled: true,
    force_disabled: Boolean(c.force_disabled),
    allowlist_computer_ids: [],
    wake_user_ids: Array.isArray(c.wake_user_ids) ? c.wake_user_ids : [],
    cooldown_seconds: Number.isFinite(c.cooldown_seconds) ? c.cooldown_seconds : 0,
  }
}

export function SettingsWolPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [cfg, setCfg] = useState<WolConfig | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [c, u] = await Promise.all([api.wolConfig(), api.users()])
      setCfg(normalizeWolConfig(c))
      setUsers(u.filter((x) => x.is_active && !x.is_ldap && x.role !== 'directory'))
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

  async function savePatch(patch: Parameters<typeof api.updateWolConfig>[0]) {
    if (!cfg || saving) return
    setSaving(true)
    try {
      setCfg(normalizeWolConfig(await api.updateWolConfig(patch)))
      toast.ok(t('settingsWol.saved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setSaving(false)
    }
  }

  function toggleUser(id: number, on: boolean) {
    if (!cfg) return
    const set = new Set(cfg.wake_user_ids ?? [])
    if (on) set.add(id)
    else set.delete(id)
    void savePatch({ wake_user_ids: [...set].sort((a, b) => a - b) })
  }

  return (
    <div>
      <PageHeader
        icon={<IconPcs className="h-7 w-7" />}
        title={t('titles.wol')}
        subtitle={t('pages.wolSubtitle')}
      />

      {loading || !cfg ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
      ) : (
        <div className="space-y-6">
          {cfg.force_disabled ? (
            <div className="app-alert app-alert-warning text-sm">{t('settingsWol.forceOff')}</div>
          ) : null}

          <section className="app-card p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsWol.operators')}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsWol.operatorsHint')}</p>
            <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              {users.length === 0 ? (
                <p className="px-2 py-3 text-sm text-[var(--color-fg-muted)]">{t('settingsWol.noUsers')}</p>
              ) : (
                users.map((u) => (
                  <label
                    key={u.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      checked={u.is_superuser || (cfg.wake_user_ids ?? []).includes(u.id)}
                      disabled={saving || u.is_superuser}
                      onChange={(e) => toggleUser(u.id, e.target.checked)}
                    />
                    <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">
                      {u.full_name || u.username}
                      {u.is_superuser ? (
                        <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">{t('settingsWol.adminAlways')}</span>
                      ) : null}
                    </span>
                  </label>
                ))
              )}
            </div>
            <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
              <Link to="/users" className="text-blue-700 underline-offset-2 hover:underline">
                {t('settingsWol.manageUsers')}
              </Link>
            </p>
          </section>

          <section className="app-card p-4 sm:p-5">
            <label className="block text-sm text-[var(--color-fg)]">
              {t('settingsWol.cooldown')}
              <input
                type="number"
                min={0}
                max={3600}
                className="app-input mt-1 max-w-[10rem]"
                value={cfg.cooldown_seconds}
                disabled={saving}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10)
                  if (Number.isFinite(n)) setCfg({ ...cfg, cooldown_seconds: n })
                }}
                onBlur={() => {
                  const n = Math.max(0, Math.min(3600, cfg.cooldown_seconds || 0))
                  void savePatch({ cooldown_seconds: n })
                }}
              />
            </label>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsWol.cooldownHint')}</p>
          </section>
        </div>
      )}
    </div>
  )
}
