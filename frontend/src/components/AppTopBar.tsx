import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api, type Computer, type NetworkPrinter, type ServiceRequestRow } from '../api'
import { useAuth } from '../AuthContext'
import { useTheme } from '../ThemeContext'
import { useLocale } from '../i18n/LocaleContext'
import {
  readNotificationPrefs,
  unreadAssigned,
  writeNotificationPrefs,
  type NotificationPrefs,
} from '../lib/notificationPrefs'
import { useToast } from '../ToastContext'
import { IconBell, IconMoon, IconPcs, IconPrinter, IconSearch, IconSun, IconTicket } from './icons'

type SearchHit =
  | { kind: 'computer'; id: number; title: string; subtitle: string; to: string }
  | { kind: 'printer'; id: number; title: string; subtitle: string; to: string }
  | { kind: 'request'; id: number; title: string; subtitle: string; to: string }

function chromeBtnClass(active = false) {
  return `relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)] ${
    active ? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)]' : ''
  }`
}

function requestLabel(r: ServiceRequestRow): string {
  return r.ticket_no != null ? `#${r.ticket_no} · ${r.title}` : r.title
}

export function AppTopBar() {
  const { t } = useLocale()
  const { user } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const toast = useToast()
  const navigate = useNavigate()
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const notifyWrapRef = useRef<HTMLDivElement>(null)
  const knownIdsRef = useRef<Set<number> | null>(null)
  const prefsRef = useRef<NotificationPrefs>({ enabled: true, readIds: [] })

  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [hits, setHits] = useState<SearchHit[]>([])

  const [notifyOpen, setNotifyOpen] = useState(false)
  const [assigned, setAssigned] = useState<ServiceRequestRow[]>([])
  const [notifyLoading, setNotifyLoading] = useState(false)
  const [notifyPrefs, setNotifyPrefs] = useState<NotificationPrefs>({ enabled: true, readIds: [] })

  useEffect(() => {
    if (!user) {
      setNotifyPrefs({ enabled: true, readIds: [] })
      prefsRef.current = { enabled: true, readIds: [] }
      knownIdsRef.current = null
      return
    }
    const prefs = readNotificationPrefs(user.id)
    setNotifyPrefs(prefs)
    prefsRef.current = prefs
    knownIdsRef.current = null
  }, [user?.id])

  const persistPrefs = (next: NotificationPrefs) => {
    if (!user) return
    setNotifyPrefs(next)
    prefsRef.current = next
    writeNotificationPrefs(user.id, next)
    window.dispatchEvent(new Event('corax:notify-prefs'))
  }

  const unread = useMemo(
    () => unreadAssigned(assigned, notifyPrefs) as ServiceRequestRow[],
    [assigned, notifyPrefs],
  )

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      if (searchWrapRef.current && !searchWrapRef.current.contains(target)) setSearchOpen(false)
      if (notifyWrapRef.current && !notifyWrapRef.current.contains(target)) setNotifyOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setSearchLoading(false)
      return
    }
    let cancelled = false
    setSearchLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const [computersRes, printers, requestsRes] = await Promise.all([
            api.computers({ q, limit: 8, view: 'list' }),
            api.printers({ q, limit: 8 }),
            api.serviceRequests({ limit: 200 }),
          ])
          if (cancelled) return
          const qLower = q.toLowerCase()
          const computerHits: SearchHit[] = (computersRes.items as Computer[]).slice(0, 6).map((c) => ({
            kind: 'computer',
            id: c.id,
            title: c.hostname,
            subtitle: [c.ip_address, c.model].filter(Boolean).join(' · ') || t('chrome.searchComputer'),
            to: `/computers?computer=${c.id}`,
          }))
          const printerHits: SearchHit[] = (printers as NetworkPrinter[]).slice(0, 6).map((p) => ({
            kind: 'printer',
            id: p.id,
            title: p.name,
            subtitle: [p.ip_address, p.location, p.snmp_model].filter(Boolean).join(' · ') || t('chrome.searchPrinter'),
            to: `/printers`,
          }))
          const requestHits: SearchHit[] = requestsRes.items
            .filter((r) => {
              const hay = [
                r.title,
                r.ticket_no != null ? String(r.ticket_no) : '',
                r.computer_hostname || '',
                r.requester_name || '',
                r.location || '',
              ]
                .join(' ')
                .toLowerCase()
              return hay.includes(qLower)
            })
            .slice(0, 6)
            .map((r) => ({
              kind: 'request' as const,
              id: r.id,
              title: requestLabel(r),
              subtitle: [r.status, r.computer_hostname, r.requester_name].filter(Boolean).join(' · '),
              to: `/requests/database`,
            }))
          setHits([...computerHits, ...printerHits, ...requestHits])
          setSearchOpen(true)
        } catch {
          if (!cancelled) setHits([])
        } finally {
          if (!cancelled) setSearchLoading(false)
        }
      })()
    }, 280)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [query, t])

  useEffect(() => {
    if (!user) {
      setAssigned([])
      return
    }
    let cancelled = false
    let first = true
    const load = async () => {
      if (first) setNotifyLoading(true)
      try {
        const [openRes, progressRes] = await Promise.all([
          api.serviceRequests({ status: 'open', limit: 200 }),
          api.serviceRequests({ status: 'in_progress', limit: 200 }),
        ])
        if (cancelled) return
        const mine = [...openRes.items, ...progressRes.items]
          .filter((r) => {
            const ids = new Set<number>([user.id])
            if (user.linked_directory_user_id) ids.add(user.linked_directory_user_id)
            return r.assignee_ids.some((id) => ids.has(id))
          })
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .slice(0, 12)

        const prefs = prefsRef.current
        const currentIds = new Set(mine.map((r) => r.id))
        if (knownIdsRef.current == null) {
          knownIdsRef.current = currentIds
        } else if (prefs.enabled) {
          const fresh = mine.filter((r) => !knownIdsRef.current!.has(r.id) && !prefs.readIds.includes(r.id))
          if (fresh.length === 1) {
            toast.info(t('chrome.notifyNewOne', { title: requestLabel(fresh[0]) }))
          } else if (fresh.length > 1) {
            toast.info(t('chrome.notifyNewMany', { n: fresh.length }))
          }
          knownIdsRef.current = new Set([...knownIdsRef.current, ...currentIds])
        } else {
          knownIdsRef.current = currentIds
        }

        setAssigned(mine)
      } catch {
        if (!cancelled) setAssigned([])
      } finally {
        if (!cancelled) {
          first = false
          setNotifyLoading(false)
        }
      }
    }
    void load()
    const onRefresh = () => {
      void load()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('corax:assignee-notifications', onRefresh)
    window.addEventListener('focus', onRefresh)
    document.addEventListener('visibilitychange', onVisible)
    const onPrefsChanged = () => {
      if (!user) return
      const prefs = readNotificationPrefs(user.id)
      setNotifyPrefs(prefs)
      prefsRef.current = prefs
    }
    window.addEventListener('storage', onPrefsChanged)
    window.addEventListener('corax:notify-prefs', onPrefsChanged)
    let timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5_000)
    const onVisForInterval = () => {
      window.clearInterval(timer)
      const ms = document.visibilityState === 'visible' ? 5_000 : 30_000
      timer = window.setInterval(() => void load(), ms)
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisForInterval)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('corax:assignee-notifications', onRefresh)
      window.removeEventListener('focus', onRefresh)
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('visibilitychange', onVisForInterval)
      window.removeEventListener('storage', onPrefsChanged)
      window.removeEventListener('corax:notify-prefs', onPrefsChanged)
    }
  }, [user, t, toast])

  const groupedHits = useMemo(() => {
    const computers = hits.filter((h) => h.kind === 'computer')
    const printers = hits.filter((h) => h.kind === 'printer')
    const requests = hits.filter((h) => h.kind === 'request')
    return { computers, printers, requests }
  }, [hits])

  const goHit = (hit: SearchHit) => {
    setSearchOpen(false)
    setQuery('')
    navigate(hit.to)
  }

  const markAllRead = () => {
    if (!user) return
    const ids = assigned.map((r) => r.id)
    persistPrefs({
      ...notifyPrefs,
      readIds: [...new Set([...notifyPrefs.readIds, ...ids])],
    })
  }

  const markOneRead = (id: number) => {
    if (!user) return
    persistPrefs({
      ...notifyPrefs,
      readIds: [...new Set([...notifyPrefs.readIds, id])],
    })
  }

  const showDot = notifyPrefs.enabled && unread.length > 0

  return (
    <div className="flex items-center gap-2 sm:gap-3">
      <div ref={searchWrapRef} className="relative min-w-0 flex-1">
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-subtle)]" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => {
              if (query.trim().length >= 2) setSearchOpen(true)
            }}
            placeholder={t('chrome.searchPlaceholder')}
            className="app-input !min-h-[40px] !rounded-full !border-[var(--color-border)] !bg-[var(--color-surface)] !py-2 !pl-10 !pr-4 !text-[13px] !shadow-none"
            aria-label={t('chrome.searchAria')}
            autoComplete="off"
          />
        </div>
        {searchOpen && query.trim().length >= 2 ? (
          <div className="absolute left-0 right-0 top-[calc(100%+0.4rem)] z-40 overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_12px_40px_rgba(15,23,42,0.12)]">
            {searchLoading ? (
              <div className="px-4 py-3 text-xs text-[var(--color-fg-subtle)]">{t('chrome.searchLoading')}</div>
            ) : hits.length === 0 ? (
              <div className="px-4 py-3 text-xs text-[var(--color-fg-subtle)]">{t('chrome.searchEmpty')}</div>
            ) : (
              <div className="max-h-[min(24rem,60vh)] overflow-y-auto py-1.5">
                {(
                  [
                    ['computers', groupedHits.computers, IconPcs, t('chrome.searchComputer')] as const,
                    ['printers', groupedHits.printers, IconPrinter, t('chrome.searchPrinter')] as const,
                    ['requests', groupedHits.requests, IconTicket, t('chrome.searchRequest')] as const,
                  ] as const
                ).map(([key, items, Icon, label]) =>
                  items.length === 0 ? null : (
                    <div key={key} className="px-1.5 py-1">
                      <div className="px-2.5 pb-1 pt-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">
                        {label}
                      </div>
                      {items.map((hit) => (
                        <button
                          key={`${hit.kind}-${hit.id}`}
                          type="button"
                          onClick={() => goHit(hit)}
                          className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition hover:bg-[var(--color-surface-muted)]"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-[var(--color-fg)]">{hit.title}</span>
                            {hit.subtitle ? (
                              <span className="mt-0.5 block truncate text-[11px] text-[var(--color-fg-subtle)]">{hit.subtitle}</span>
                            ) : null}
                          </span>
                        </button>
                      ))}
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <button
        type="button"
        className={chromeBtnClass()}
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect()
          toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
        }}
        aria-label={theme === 'dark' ? t('prefs.themeLight') : t('prefs.themeDark')}
        title={theme === 'dark' ? t('prefs.themeLight') : t('prefs.themeDark')}
      >
        {theme === 'dark' ? <IconSun className="h-[18px] w-[18px]" /> : <IconMoon className="h-[18px] w-[18px]" />}
      </button>

      <div ref={notifyWrapRef} className="relative">
        <button
          type="button"
          className={`${chromeBtnClass(notifyOpen)} ${!notifyPrefs.enabled ? 'opacity-60' : ''}`}
          onClick={() => setNotifyOpen((v) => !v)}
          aria-label={t('chrome.notifications')}
          title={
            notifyPrefs.enabled
              ? t('chrome.notifications')
              : t('chrome.notificationsDisabled')
          }
          aria-expanded={notifyOpen}
        >
          <IconBell className="h-[18px] w-[18px]" />
          {showDot ? (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[var(--color-primary)] ring-2 ring-[var(--color-surface)]" />
          ) : null}
        </button>
        {notifyOpen ? (
          <div className="absolute right-0 top-[calc(100%+0.4rem)] z-40 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_12px_40px_rgba(15,23,42,0.12)]">
            <div className="border-b border-[var(--color-border)] px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[13px] font-semibold text-[var(--color-fg)]">{t('chrome.notifications')}</div>
                <Link
                  to="/requests/database"
                  onClick={() => setNotifyOpen(false)}
                  className="text-[11px] font-medium text-[var(--color-primary)] no-underline hover:underline"
                >
                  {t('chrome.notificationsAll')}
                </Link>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
                  <input
                    type="checkbox"
                    className="h-3.5 w-3.5 rounded border-[var(--color-border)]"
                    checked={notifyPrefs.enabled}
                    onChange={(e) => {
                      persistPrefs({ ...notifyPrefs, enabled: e.target.checked })
                    }}
                  />
                  {t('chrome.notificationsEnabled')}
                </label>
                {notifyPrefs.enabled && unread.length > 0 ? (
                  <button
                    type="button"
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface)]"
                    onClick={markAllRead}
                  >
                    {t('chrome.notificationsMarkRead')}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="max-h-[min(20rem,55vh)] overflow-y-auto">
              {!notifyPrefs.enabled ? (
                <div className="border-b border-[var(--color-border)] px-3.5 py-2.5 text-[11px] text-[var(--color-fg-subtle)]">
                  {t('chrome.notificationsOffHint')}
                </div>
              ) : null}
              {notifyLoading && assigned.length === 0 ? (
                <div className="px-3.5 py-4 text-xs text-[var(--color-fg-subtle)]">{t('chrome.notificationsLoading')}</div>
              ) : assigned.length === 0 ? (
                <div className="px-3.5 py-4 text-xs text-[var(--color-fg-subtle)]">{t('chrome.notificationsEmpty')}</div>
              ) : (
                assigned.map((r) => {
                  const isUnread = notifyPrefs.enabled && !notifyPrefs.readIds.includes(r.id)
                  return (
                    <div
                      key={r.id}
                      className={`flex gap-2.5 border-b border-[var(--color-border)] px-3.5 py-2.5 last:border-b-0 ${
                        isUnread ? 'bg-[var(--color-primary-muted)]/35' : ''
                      }`}
                    >
                      <Link
                        to="/requests/database"
                        onClick={() => {
                          if (notifyPrefs.enabled) markOneRead(r.id)
                          setNotifyOpen(false)
                        }}
                        className="flex min-w-0 flex-1 gap-2.5 text-[var(--color-fg)] no-underline hover:opacity-90"
                      >
                        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
                          <IconTicket className="h-3.5 w-3.5" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            {isUnread ? (
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-primary)]" />
                            ) : null}
                            <span className="block truncate text-[13px] font-medium">{requestLabel(r)}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-[11px] text-[var(--color-fg-subtle)]">
                            {[
                              r.status === 'in_progress' ? t('chrome.statusInProgress') : t('chrome.statusOpen'),
                              r.computer_hostname,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                      </Link>
                      {isUnread ? (
                        <button
                          type="button"
                          className="shrink-0 self-center rounded-md px-1.5 py-1 text-[10px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-surface)]"
                          onClick={() => markOneRead(r.id)}
                          title={t('chrome.notificationsMarkOne')}
                        >
                          {t('chrome.notificationsMarkOne')}
                        </button>
                      ) : null}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
