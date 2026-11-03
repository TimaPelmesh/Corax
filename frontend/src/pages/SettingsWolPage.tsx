import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { api, type User, type WolConfig, type WolJournalItem } from '../api'
import { useAuth } from '../AuthContext'
import { IconPcs } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { SettingsStatusBoard } from '../components/settings/SettingsStatusBoard'
import { Skeleton } from '../components/Skeleton'
import { StatusPill } from '../components/ui/StatusPill'
import { useLocale, useT, type MessageKey } from '../i18n/LocaleContext'
import { relativeAge, wakeOperatorCount } from '../lib/settingsOpsStatus'
import { useToast } from '../ToastContext'

const COOLDOWN_PRESETS = [0, 30, 60, 300] as const

function normalizeWolConfig(c: WolConfig): WolConfig {
  return {
    enabled: true,
    force_disabled: Boolean(c.force_disabled),
    allowlist_computer_ids: [],
    wake_user_ids: Array.isArray(c.wake_user_ids) ? c.wake_user_ids : [],
    cooldown_seconds: Number.isFinite(c.cooldown_seconds) ? c.cooldown_seconds : 0,
  }
}

function roleKey(user: User): MessageKey {
  if (user.is_superuser) return 'roles.admin'
  if (user.role === 'editor') return 'roles.editor'
  if (user.role === 'llm-operator') return 'roles.llmOperator'
  return 'roles.viewer'
}

export function SettingsWolPage() {
  const t = useT()
  const { locale } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const [cfg, setCfg] = useState<WolConfig | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [journal, setJournal] = useState<WolJournalItem[]>([])
  const [query, setQuery] = useState('')

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

  const operators = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rows = [...users].sort((a, b) => Number(b.is_superuser) - Number(a.is_superuser) || (a.full_name || a.username).localeCompare(b.full_name || b.username, locale))
    if (!q) return rows
    return rows.filter((row) => `${row.full_name || ''} ${row.username}`.toLowerCase().includes(q))
  }, [locale, query, users])

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  async function savePatch(patch: Parameters<typeof api.updateWolConfig>[0]) {
    if (!cfg || saving) return false
    setSaving(true)
    try {
      setCfg(normalizeWolConfig(await api.updateWolConfig(patch)))
      toast.ok(t('settingsWol.saved'))
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
      return false
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

  function commitCooldown(raw: number) {
    if (!cfg) return
    const next = Math.max(0, Math.min(3600, Math.trunc(raw) || 0))
    if (next === cfg.cooldown_seconds) return
    const prev = cfg.cooldown_seconds
    setCfg({ ...cfg, cooldown_seconds: next })
    void savePatch({ cooldown_seconds: next }).then((ok) => {
      if (!ok) setCfg((current) => (current ? { ...current, cooldown_seconds: prev } : current))
    })
  }

  const allowed = cfg ? wakeOperatorCount(users, cfg.wake_user_ids ?? []) : 0
  const last = journal[0] ?? null
  const age = relativeAge(last?.at)
  const lastLabel =
    age.kind === 'none'
      ? t('settingsWol.lastNone')
      : age.kind === 'just'
        ? t('settingsWol.lastJust')
        : age.kind === 'minutes'
          ? t('settingsWol.lastMinutes', { n: age.n })
          : age.kind === 'hours'
            ? t('settingsWol.lastHours', { n: age.n })
            : t('settingsWol.lastDays', { n: age.n })
  const presetLabel: Record<(typeof COOLDOWN_PRESETS)[number], MessageKey> = {
    0: 'settingsWol.presetNone',
    30: 'settingsWol.preset30',
    60: 'settingsWol.preset60',
    300: 'settingsWol.preset300',
  }

  return (
    <div className="settings-page settings-page--wide">
      <PageHeader
        icon={<IconPcs className="h-7 w-7" />}
        title={t('titles.wol')}
        subtitle={t('pages.wolSubtitle')}
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
          <SettingsStatusBoard
            tone={cfg.force_disabled ? 'warning' : 'success'}
            kicker={cfg.force_disabled ? t('settingsWol.kickerOff') : t('settingsWol.kickerOn')}
            title={cfg.force_disabled ? t('settingsWol.offTitle') : t('settingsWol.liveTitle')}
            detail={cfg.force_disabled ? t('settingsWol.forceOff') : t('settingsWol.liveDetail')}
            facts={[
              {
                label: t('settingsWol.factOperators'),
                value: t('settingsWol.operatorsCount', { n: allowed, total: users.length }),
              },
              {
                label: t('settingsWol.factCooldown'),
                value: cfg.cooldown_seconds > 0 ? t('settingsWol.cooldownValue', { n: cfg.cooldown_seconds }) : t('settingsWol.noCooldown'),
              },
              {
                label: t('settingsWol.factLast'),
                value: last
                  ? `${lastLabel} · ${last.sent > 0 ? t('settingsWol.packetSent') : t('settingsWol.packetFailed')}`
                  : lastLabel,
                title: last ? `${last.hostname}${last.by ? ` · ${last.by}` : ''}` : undefined,
              },
            ]}
            actions={
              <Link to="/computers" className="app-btn app-btn-secondary w-full !min-h-9 sm:w-auto">
                {t('settingsWol.openComputers')}
              </Link>
            }
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(16rem,0.7fr)]">
            <section className="app-panel">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsWol.operators')}</h2>
                  <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsWol.operatorsHint')}</p>
                </div>
                <p className="text-xs font-medium tabular-nums text-[var(--color-fg-subtle)]">
                  {t('settingsWol.operatorsCount', { n: allowed, total: users.length })}
                </p>
              </div>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('settingsWol.searchOperators')}
                className="app-input mt-3"
                aria-label={t('settingsWol.searchOperators')}
              />
              <div className="mt-3 max-h-80 space-y-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                {users.length === 0 ? (
                  <div className="app-empty-state !py-6">{t('settingsWol.noUsers')}</div>
                ) : operators.length === 0 ? (
                  <div className="app-empty-state !py-6">{t('common.nothingFound')}</div>
                ) : (
                  operators.map((row) => {
                    const on = row.is_superuser || (cfg.wake_user_ids ?? []).includes(row.id)
                    return (
                      <label
                        key={row.id}
                        className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-[var(--color-surface-muted)]"
                      >
                        <input
                          type="checkbox"
                          className="rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                          checked={on}
                          disabled={saving || row.is_superuser}
                          onChange={(e) => toggleUser(row.id, e.target.checked)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-[var(--color-fg)]">
                            {row.full_name || row.username}
                          </span>
                          <span className="block truncate text-xs text-[var(--color-fg-subtle)]">
                            {row.username}
                            {row.is_superuser ? ` · ${t('settingsWol.adminAlways')}` : ''}
                          </span>
                        </span>
                        <StatusPill tone={on ? 'success' : 'neutral'}>{t(roleKey(row))}</StatusPill>
                      </label>
                    )
                  })
                )}
              </div>
              <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
                <Link to="/users" className="font-medium text-[var(--color-primary)] underline-offset-2 hover:underline">
                  {t('settingsWol.manageUsers')}
                </Link>
              </p>
            </section>

            <section className="app-panel">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsWol.cooldown')}</h2>
              <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('settingsWol.cooldownHint')}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {COOLDOWN_PRESETS.map((value) => {
                  const on = cfg.cooldown_seconds === value
                  return (
                    <button
                      key={value}
                      type="button"
                      disabled={saving}
                      aria-pressed={on}
                      className={`app-chip ${on ? 'app-chip--active' : ''}`}
                      onClick={() => commitCooldown(value)}
                    >
                      {t(presetLabel[value])}
                    </button>
                  )
                })}
              </div>
              <label className="mt-3 block text-sm text-[var(--color-fg)]">
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
                  onBlur={() => commitCooldown(cfg.cooldown_seconds)}
                />
              </label>
            </section>
          </div>

          <section className="app-panel">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsWol.journal')}</h2>
            {journal.length === 0 ? (
              <div className="app-empty-state mt-3 !py-8">
                <p>{t('settingsWol.journalEmpty')}</p>
                <p className="mx-auto mt-1 max-w-md text-xs">{t('settingsWol.journalEmptyHint')}</p>
                <Link to="/computers" className="app-btn app-btn-secondary mt-3">
                  {t('settingsWol.openComputers')}
                </Link>
              </div>
            ) : (
              <div className="app-table-shell mt-3 overflow-x-auto">
                <table className="app-table w-full min-w-[36rem] text-left text-sm">
                  <thead>
                    <tr className="app-table-head">
                      <th className="px-3 py-2 font-medium">{t('settingsWol.journalWhen')}</th>
                      <th className="px-3 py-2 font-medium">{t('settingsWol.journalHost')}</th>
                      <th className="px-3 py-2 font-medium">{t('settingsWol.journalBy')}</th>
                      <th className="px-3 py-2 font-medium">{t('settingsWol.journalResult')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {journal.map((row) => {
                      const rowAge = relativeAge(row.at)
                      const when =
                        rowAge.kind === 'none'
                          ? '—'
                          : rowAge.kind === 'just'
                            ? t('settingsWol.lastJust')
                            : rowAge.kind === 'minutes'
                              ? t('settingsWol.lastMinutes', { n: rowAge.n })
                              : rowAge.kind === 'hours'
                                ? t('settingsWol.lastHours', { n: rowAge.n })
                                : t('settingsWol.lastDays', { n: rowAge.n })
                      const exact = row.at
                        ? new Date(row.at).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
                            day: '2-digit',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''
                      return (
                        <tr key={row.id} className="app-table-row border-t border-[var(--color-border)]">
                          <td className="px-3 py-2 text-[var(--color-fg-muted)]" title={exact}>
                            {when}
                          </td>
                          <td className="px-3 py-2 font-medium text-[var(--color-fg)]">{row.hostname}</td>
                          <td className="px-3 py-2 text-[var(--color-fg-muted)]">{row.by || '—'}</td>
                          <td className="px-3 py-2">
                            <StatusPill tone={row.sent > 0 ? 'success' : 'error'}>
                              {row.sent > 0 ? t('settingsWol.packetSent') : t('settingsWol.packetFailed')}
                            </StatusPill>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )
      }
    </div>
  )
}
