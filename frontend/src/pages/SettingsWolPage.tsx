import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, type User, type WolConfig, type WolJournalItem } from '../api'
import { useAuth } from '../AuthContext'
import { IconPcs } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { Skeleton } from '../components/Skeleton'
import { StatusPill } from '../components/ui/StatusPill'
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
  const [loadError, setLoadError] = useState<string | null>(null)
  const [journal, setJournal] = useState<WolJournalItem[]>([])

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const [c, u, wakes] = await Promise.all([
        api.wolConfig(),
        api.users(),
        api.wolJournal().catch(() => ({ items: [] as WolJournalItem[] })),
      ])
      setCfg(normalizeWolConfig(c))
      setUsers(u.filter((x) => x.is_active && !x.is_ldap && x.role !== 'directory'))
      setJournal(wakes.items)
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('common.error')
      setLoadError(msg)
      toast.error(msg)
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
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <PageHeader
        icon={<IconPcs className="h-7 w-7" />}
        title={t('titles.wol')}
        subtitle={t('pages.wolSubtitle')}
        actions={
          cfg ? (
            <StatusPill tone={cfg.force_disabled ? 'warning' : 'success'}>
              {cfg.force_disabled ? t('settingsWol.statusForcedOff') : t('settingsWol.statusReady')}
            </StatusPill>
          ) : null
        }
      />

      {loading ? (
        <div className="space-y-3" role="status" aria-busy="true">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : loadError || !cfg ? (
        <section className="app-panel space-y-3">
          <p className="text-sm text-[var(--color-fg)]">{loadError || t('common.error')}</p>
          <button
            type="button"
            className="app-btn app-btn-primary w-full sm:w-auto"
            onClick={() => {
              setLoading(true)
              void load()
            }}
          >
            {t('common.refresh')}
          </button>
        </section>
      ) : (
        <div className="space-y-4">
          {cfg.force_disabled ? (
            <div className="app-alert app-alert-warning text-sm">{t('settingsWol.forceOff')}</div>
          ) : null}

          <section className="app-panel">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsWol.operators')}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsWol.operatorsHint')}</p>
            <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
              {users.length === 0 ? (
                <div className="app-empty-state !py-6">{t('settingsWol.noUsers')}</div>
              ) : (
                users.map((u) => (
                  <label
                    key={u.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--color-surface-muted)]"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
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
              <Link to="/users" className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline">
                {t('settingsWol.manageUsers')}
              </Link>
            </p>
          </section>

          <section className="app-panel">
            <label className="block text-sm text-[var(--color-fg)]">
              {t('settingsWol.cooldown')}
              <input
                type="number"
                min={0}
                max={3600}
                className="app-input mt-1 w-full max-w-[10rem]"
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

          <section className="app-panel">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsWol.journal')}</h2>
            {journal.length === 0 ? (
              <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t('settingsWol.journalEmpty')}</p>
            ) : (
              <ul className="mt-2 space-y-2 text-sm">
                {journal.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-[var(--color-fg)]">{row.hostname}</span>
                    <StatusPill tone={row.sent > 0 ? 'success' : 'error'}>
                      {row.sent > 0 ? t('settingsWol.packetSent') : t('settingsWol.packetFailed')}
                    </StatusPill>
                    <span className="text-[var(--color-fg-muted)]">
                      {row.by}
                      {row.at ? ` · ${row.at.replace('T', ' ').slice(0, 16)}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
