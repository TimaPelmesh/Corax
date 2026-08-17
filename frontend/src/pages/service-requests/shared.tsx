import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  type Computer,
  type RequestCategoryTreeNode,
  type ServiceRequestRow,
  type UserDirectoryItem,
} from '../../api'
import { collectCategoryPaths, filterCategoryTree, flattenCategoryNodes } from '../../requestCategories'
import { useT, translateStatic } from '../../i18n/LocaleContext'

export const REQUEST_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const
export const REQUEST_PRIORITIES = ['low', 'normal', 'high'] as const

export const CREATE_FORM_INPUT_CLS =
  'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm outline-none placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-primary)]'
export const CREATE_FORM_LABEL_CLS = 'mb-1 block text-xs font-medium text-[var(--color-fg-subtle)]'
export const STATS_BASES = ['opened', 'last_change', 'closed'] as const
export const STATS_GROUPS = ['day', 'week'] as const
export const STATS_CHART_MODES = ['total', 'status'] as const

export type RequestStatus = (typeof REQUEST_STATUSES)[number]
export type RequestPriority = (typeof REQUEST_PRIORITIES)[number]
export type StatsBasis = (typeof STATS_BASES)[number]
export type StatsGroup = (typeof STATS_GROUPS)[number]
export type StatsChartMode = (typeof STATS_CHART_MODES)[number]

export const STATUS_PILL: Record<string, string> = {
  open: 'bg-[var(--color-surface)] text-[var(--color-fg)] ring-1 ring-neutral-200/90',
  in_progress: 'bg-[var(--color-surface)] text-[var(--color-fg)] ring-1 ring-neutral-200/90',
  done: 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] ring-1 ring-neutral-200/90',
  cancelled: 'bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)] ring-1 ring-neutral-200/90',
}

export const RECENT_TITLE_KEY = 'service_request_recent_titles_v1'
export const RECENT_TITLES_MAX = 8
export const DB_PAGE_SIZE_KEY = 'service_request_database_page_size_v1'
export const DB_PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const

export type RequestsTabId = 'create' | 'database' | 'stats' | 'templates'

export type SortKey = 'opened_desc' | 'closed_desc' | 'id_asc' | 'id_desc' | 'priority_desc'

export function isRequestStatus(value: string): value is RequestStatus {
  return REQUEST_STATUSES.includes(value as RequestStatus)
}

export function isRequestPriority(value: string): value is RequestPriority {
  return REQUEST_PRIORITIES.includes(value as RequestPriority)
}

export function readDatabasePageSize(): (typeof DB_PAGE_SIZE_OPTIONS)[number] {
  try {
    const value = Number(localStorage.getItem(DB_PAGE_SIZE_KEY))
    return DB_PAGE_SIZE_OPTIONS.includes(value as (typeof DB_PAGE_SIZE_OPTIONS)[number]) ? value as (typeof DB_PAGE_SIZE_OPTIONS)[number] : 100
  } catch {
    return 100
  }
}

export function sortArrow(active: boolean) {
  return <span className={`ml-1 ${active ? 'text-[var(--color-fg-muted)]' : 'text-slate-300'}`}>{active ? '↓' : '↕'}</span>
}

export function getAppScrollContainer(): HTMLElement | null {
  return document.querySelector('main')
}

type ListScrollRestore = { path: string; scrollTop: number; requestId: number }

let pendingListScrollRestore: ListScrollRestore | null = null
let skipNextListReload = false

export function takeSkipNextListReload(): boolean {
  const v = skipNextListReload
  skipNextListReload = false
  return v
}

export function markSkipNextListReload(): void {
  skipNextListReload = true
}

export function captureListScrollForRestore(requestId: number, path: string) {
  const el = getAppScrollContainer()
  if (!el) return
  pendingListScrollRestore = { path, scrollTop: el.scrollTop, requestId }
}

export function scheduleListScrollRestore(expectedPath: string) {
  const saved = pendingListScrollRestore
  if (!saved || saved.path !== expectedPath) return

  const { scrollTop, requestId } = saved

  const tryApply = (allowScrollFallback = false) => {
    if (!pendingListScrollRestore || pendingListScrollRestore.path !== expectedPath) return true

    const row = document.querySelector(`tr[data-request-id="${requestId}"]`)
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' })
      pendingListScrollRestore = null
      return true
    }

    const main = getAppScrollContainer()
    if (allowScrollFallback && main && main.scrollHeight >= scrollTop) {
      main.scrollTop = scrollTop
      pendingListScrollRestore = null
      return true
    }

    return false
  }

  if (tryApply()) return

  for (const ms of [0, 16, 50, 100, 200, 350, 500]) {
    window.setTimeout(() => {
      tryApply(ms === 500)
    }, ms)
  }
}

export function readRecentTitles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_TITLE_KEY)
    if (!raw) return []
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(0, RECENT_TITLES_MAX) : []
  } catch {
    return []
  }
}

export function pushRecentTitle(title: string) {
  const t = title.trim()
  if (!t) return
  const prev = readRecentTitles().filter((x) => x !== t)
  const next = [t, ...prev].slice(0, RECENT_TITLES_MAX)
  localStorage.setItem(RECENT_TITLE_KEY, JSON.stringify(next))
}

export function removeRecentTitle(title: string) {
  const next = readRecentTitles().filter((x) => x !== title)
  localStorage.setItem(RECENT_TITLE_KEY, JSON.stringify(next))
}

/** Значение для input[type=datetime-local] в локальной зоне */
export function parseIsoToDate(iso: string): Date | null {
  const s = iso.trim()
  if (!s) return null
  // If ISO has explicit timezone (Z or ±hh:mm), native parser is fine.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s)) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  // If ISO is "YYYY-MM-DDTHH:mm(:ss(.ms))?" without timezone, treat it as LOCAL time.
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s)
  if (!m) {
    const d = new Date(s)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const da = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  const se = m[6] ? Number(m[6]) : 0
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  const d = new Date(y, mo, da, h, mi, se, ms)
  return Number.isNaN(d.getTime()) ? null : d
}

export function toDatetimeLocalValue(iso: string): string {
  const d = parseIsoToDate(iso)
  if (!d) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromDatetimeLocalValue(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function fmtRuDateTime(iso: string | null | undefined, locale: 'ru' | 'en'): string {
  if (!iso) return '—'
  try {
    const d = parseIsoToDate(iso)
    if (!d) return '—'
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

export function fmtRuShortDateTime(iso: string | null | undefined, locale: 'ru' | 'en'): string {
  if (!iso) return '—'
  try {
    const d = parseIsoToDate(iso)
    if (!d) return '—'
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

export function requestStatusLabel(value: string): string {
  switch (value) {
    case 'open':
      return translateStatic('requests.status.open')
    case 'in_progress':
      return translateStatic('requests.status.inProgress')
    case 'done':
      return translateStatic('requests.status.done')
    case 'cancelled':
      return translateStatic('requests.status.cancelled')
    default:
      return value
  }
}

export function requestPriorityLabel(value: string): string {
  switch (value) {
    case 'low':
      return translateStatic('requests.priority.low')
    case 'normal':
      return translateStatic('requests.priority.normal')
    case 'high':
      return translateStatic('requests.priority.high')
    default:
      return value
  }
}

export function durationPresetLabel(minutes: number): string {
  switch (minutes) {
    case 15:
      return translateStatic('requests.durations.min15')
    case 30:
      return translateStatic('requests.durations.min30')
    case 60:
      return translateStatic('requests.durations.min60')
    case 90:
      return translateStatic('requests.durations.min90')
    default:
      return `${minutes} min`
  }
}

export function requestPluralLabel(count: number): string {
  if (count === 1) return translateStatic('requests.stats.requestOne')
  if (count >= 2 && count <= 4) return translateStatic('requests.stats.requestFew')
  return translateStatic('requests.stats.requestMany')
}

/** Стабильный ID заявки в CORAX (не меняется при редактировании). */
export function requestDisplayNo(r: { id: number; ticket_no?: number | null }): string {
  return String(r.id)
}

export function compareRequestId(a: { id: number }, b: { id: number }, dir: 'asc' | 'desc'): number {
  return dir === 'asc' ? a.id - b.id : b.id - a.id
}

export function pickLastChangeIso(r: ServiceRequestRow): string | null {
  return (r.glpi_updated_at ?? r.updated_at) || null
}

export function CategoryPicker({
  value,
  onChange,
  tree = [],
  label,
  placeholder,
}: {
  value: string
  onChange: (v: string) => void
  tree?: RequestCategoryTreeNode[]
  label?: string
  placeholder?: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  const boxRef = useRef<HTMLDivElement>(null)

  const filteredTree = useMemo(() => filterCategoryTree(tree, query), [tree, query])

  const flatFiltered = useMemo(() => flattenCategoryNodes(filteredTree).slice(0, 80), [filteredTree])

  const allPaths = useMemo(() => collectCategoryPaths(tree), [tree])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    setQuery(value)
  }, [value])

  return (
    <div ref={boxRef} className="relative">
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
        {label ?? t('requests.categoryPicker.label')}
      </label>
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={placeholder ?? t('requests.categoryPicker.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setOpen(false)
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const first = flatFiltered[0]
              if (first) {
                onChange(first.node.path)
                setQuery(first.node.path)
                setOpen(false)
              }
            }
          }}
          className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] shadow-sm placeholder:text-[var(--color-fg-subtle)] transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
        />
        {value.trim() ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
            onClick={() => {
              onChange('')
              setQuery('')
              setOpen(false)
            }}
            title={t('requests.categoryPicker.resetTitle')}
          >
            {t('requests.categoryPicker.reset')}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
          role="listbox"
        >
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              onClick={() => {
                onChange('')
                setQuery('')
                setOpen(false)
              }}
            >
              {t('requests.categoryPicker.unspecified')}
            </button>
          </li>
          {flatFiltered.map(({ node, depth }) => {
            const active = value.trim() === node.path.trim()
            return (
              <li key={node.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-1 py-2 text-left text-sm ${
                    active ? 'bg-blue-50/70 text-[var(--color-fg)]' : 'text-[var(--color-fg)] hover:bg-zinc-50/80'
                  }`}
                  style={{ paddingLeft: `${12 + depth * 14}px`, paddingRight: '12px' }}
                  onClick={() => {
                    onChange(node.path)
                    setQuery(node.path)
                    setOpen(false)
                  }}
                  title={node.path}
                >
                  <span className="shrink-0 text-[10px] text-slate-300" aria-hidden>
                    {depth > 0 ? '└' : '●'}
                  </span>
                  <span className="min-w-0 truncate">
                    <span className={depth === 0 ? 'font-semibold' : ''}>{node.name}</span>
                    {depth > 0 ? (
                      <span className="ml-1 text-xs text-[var(--color-fg-subtle)]">({node.path})</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
          {flatFiltered.length === 0 && allPaths.length > 0 ? (
            <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">{t('requests.categoryPicker.nothingFound')}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

export function defaultOpenedLocal(): string {
  return toDatetimeLocalValue(new Date().toISOString())
}

export function defaultPlannedCloseLocal(): string {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  return toDatetimeLocalValue(d.toISOString())
}

export function addMinutesToLocalDatetimeValue(localValue: string, minutes: number): string {
  const base = localValue.trim()
  const d = base ? new Date(base) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  d.setMinutes(d.getMinutes() + minutes)
  return toDatetimeLocalValue(d.toISOString())
}

// planned close UI removed (minimalistic create form)

// addDaysToLocalDatetimeValue removed (no planned close presets)

export function topNWithOther(
  items: { name: string; count: number }[],
  n: number,
  otherLabel = 'Other',
): { name: string; count: number }[] {
  const normalized = items
    .map((x) => ({ name: x.name.trim() ? x.name : '—', count: x.count }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
  if (normalized.length <= n) return normalized
  const head = normalized.slice(0, n)
  const rest = normalized.slice(n)
  const restCount = rest.reduce((s, x) => s + x.count, 0)
  return restCount > 0 ? [...head, { name: otherLabel, count: restCount }] : head
}

/** Согласованная нейтрально‑красная палитра для диаграмм */
export const DONUT_COLORS = ['#0a0a0a', '#2563eb', '#404040', '#737373', '#1d4ed8', '#525252', '#a3a3a3', '#d4d4d4']

export function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

export function ringSlicePath(cx: number, cy: number, rOut: number, rIn: number, startDeg: number, endDeg: number) {
  if (endDeg - startDeg <= 0.01) return ''
  const p0 = polar(cx, cy, rOut, startDeg)
  const p1 = polar(cx, cy, rOut, endDeg)
  const p2 = polar(cx, cy, rIn, endDeg)
  const p3 = polar(cx, cy, rIn, startDeg)
  const sweep = endDeg - startDeg
  const large = sweep > 180 ? 1 : 0
  return [
    `M ${p0.x.toFixed(2)} ${p0.y.toFixed(2)}`,
    `A ${rOut} ${rOut} 0 ${large} 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`,
    `L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`,
    `A ${rIn} ${rIn} 0 ${large} 0 ${p3.x.toFixed(2)} ${p3.y.toFixed(2)}`,
    'Z',
  ].join(' ')
}

export function DonutDistribution({
  items,
  emptyText,
  compact,
  center,
}: {
  items: { name: string; count: number }[]
  emptyText?: string
  compact?: boolean
  center?: boolean
}) {
  const t = useT()
  const [hovered, setHovered] = useState<number | null>(null)
  const normalizedItems = useMemo(() => items.filter((i) => i.count > 0), [items])
  const total = useMemo(() => normalizedItems.reduce((s, i) => s + i.count, 0), [normalizedItems])
  const centered = Boolean(center) || (compact && normalizedItems.length <= 3)

  const segments = useMemo(() => {
    if (!normalizedItems.length || total <= 0) return []
    const n = normalizedItems.length
    const gapDeg = n <= 1 ? 0 : Math.min(1.15, 360 / Math.max(24, n * 28))
    const usable = 360 - n * gapDeg
    let cursor = 0
    return normalizedItems.map((item, i) => {
      const span = n === 1 ? 360 : Math.max(0.2, (item.count / total) * usable)
      const start = cursor
      const end = cursor + span
      cursor = end + gapDeg
      return {
        item,
        i,
        d: ringSlicePath(80, 80, 74, 46, start, end),
        color: DONUT_COLORS[i % DONUT_COLORS.length],
      }
    })
  }, [normalizedItems, total])

  if (!normalizedItems.length || total <= 0) {
    return (
      <p className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-8 text-center text-sm text-[var(--color-fg-muted)]">
        {emptyText ?? t('requests.charts.noData')}
      </p>
    )
  }

  const svgSize = compact ? 132 : 168
  return (
    <div
      className={`flex flex-col gap-4 sm:flex-row sm:gap-5 ${centered ? 'items-center sm:justify-center' : 'items-stretch sm:items-center'}`}
      onMouseLeave={() => setHovered(null)}
    >
      <div className={`relative shrink-0 self-center ${centered ? 'mx-auto' : 'mx-auto sm:mx-0'}`}>
        <svg
          width={svgSize}
          height={svgSize}
          viewBox="0 0 160 160"
          className="drop-shadow-[0_8px_28px_rgb(0_0_0_/_0.08)]"
          role="img"
          aria-label={t('requests.charts.donutAria')}
        >
          {segments.length === 1 ? (
            <circle cx="80" cy="80" r="60" fill="none" stroke={segments[0].color} strokeWidth="28" />
          ) : null}
          {segments.map((s) => {
            const dim = hovered !== null && hovered !== s.i
            const active = hovered === s.i
            return (
              <path
                key={s.item.name + String(s.i)}
                d={segments.length === 1 ? '' : s.d}
                fill={s.color}
                stroke="rgb(255 255 255 / 0.92)"
                strokeWidth={active ? 1.75 : 1.25}
                strokeLinejoin="round"
                className="cursor-pointer"
                style={{
                  opacity: dim ? 0.42 : 1,
                  transition: 'opacity 100ms ease-out',
                }}
                onMouseEnter={() => setHovered(s.i)}
              />
            )
          })}
          <text
            x="80"
            y="76"
            textAnchor="middle"
            fill="currentColor"
            className="text-[var(--color-fg)]"
            style={{ fontSize: compact ? 22 : 26, fontWeight: 650 }}
          >
            {total}
          </text>
          <text
            x="80"
            y="96"
            textAnchor="middle"
            fill="currentColor"
            className="text-[var(--color-fg-muted)]"
            style={{ fontSize: 10, fontWeight: 500 }}
            opacity={0.7}
          >
            {t('requests.charts.total')}
          </text>
        </svg>
      </div>
      <ul className={`min-w-0 ${centered ? '' : 'flex-1'} ${compact ? 'space-y-1.5 text-[13px]' : 'space-y-2'}`}>
        {normalizedItems.map((row, i) => {
          const pct = Math.round((row.count / total) * 100)
          const rowDim = hovered !== null && hovered !== i
          return (
            <li
              key={row.name}
              className={`flex cursor-default items-center gap-3 rounded-lg px-1 py-1.5 text-sm transition-colors ${
                hovered === i ? 'bg-[var(--color-surface-muted)] ring-1 ring-neutral-200/70' : 'hover:bg-[var(--color-surface-muted)]'
              }`}
              style={{ opacity: rowDim ? 0.55 : 1 }}
              onMouseEnter={() => setHovered(i)}
            >
              <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm shadow-sm ring-1 ring-neutral-200/60" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span className="min-w-0 flex-1 break-words text-[13px] font-medium leading-snug text-[var(--color-fg-muted)]">{row.name}</span>
              <span className="shrink-0 font-mono text-sm font-semibold text-[var(--color-fg)]">{row.count}</span>
              <span className="shrink-0 text-xs tabular-nums text-[var(--color-fg-subtle)]">({pct}%)</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export function HorizontalBars({
  title,
  items,
  total,
}: {
  title: string
  items: { name: string; count: number }[]
  total: number
}) {
  const t = useT()
  if (!items.length || total <= 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
        {t('requests.charts.noData')}
      </div>
    )
  }
  return (
    <div>
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">{title}</div>
      <div className="space-y-2">
        {items.map((item, i) => {
          const pct = Math.max(2, Math.round((item.count / total) * 100))
          return (
            <div key={`${item.name}-${i}`} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-[var(--color-fg)]">{item.name}</span>
                <span className="shrink-0 font-mono text-[var(--color-fg)]">{item.count}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                <div className="h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export const DURATION_PRESETS_MIN = [
  { minutes: 15, hotkey: 'Alt+1' },
  { minutes: 30, hotkey: 'Alt+2' },
  { minutes: 60, hotkey: 'Alt+3' },
  { minutes: 90, hotkey: 'Alt+4' },
] as const

export function MiniStatCard({
  label,
  value,
  sub,
}: {
  label: string
  value: string | number
  sub?: string
  icon?: ReactNode
  variant?: 'neutral' | 'danger'
  compact?: boolean
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 shadow-sm">
      <div className="text-xs text-[var(--color-fg-subtle)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">{value}</div>
      {sub ? <div className="mt-1 text-xs text-[var(--color-fg-muted)]">{sub}</div> : null}
    </div>
  )
}

export function ComputerPicker({
  computers,
  valueId,
  onChange,
  className,
  labelClassName,
  inputClassName,
}: {
  computers: Computer[]
  valueId: string
  onChange: (id: string) => void
  className?: string
  labelClassName?: string
  inputClassName?: string
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)

  const selected = useMemo(
    () => (valueId ? computers.find((c) => String(c.id) === valueId) : undefined),
    [computers, valueId],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return computers.slice(0, 40)
    return computers.filter((c) => c.hostname.toLowerCase().includes(q)).slice(0, 40)
  }, [computers, query])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div ref={boxRef} className={className ?? 'relative'}>
      <label
        className={
          labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]'
        }
      >
        {t('requests.computerPicker.label')}
      </label>
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={t('requests.computerPicker.placeholder')}
          value={open ? query : selected?.hostname ?? ''}
          onChange={(e) => {
            const v = e.target.value
            setQuery(v)
            onChange('')
            setOpen(true)
          }}
          onFocus={() => {
            setQuery(selected?.hostname ?? '')
            setOpen(true)
          }}
          className={
            inputClassName ??
            'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]'
          }
        />
        {selected && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
            onClick={() => {
              onChange('')
              setQuery('')
              setOpen(false)
            }}
          >
            {t('requests.computerPicker.reset')}
          </button>
        )}
      </div>
      {open && (
        <ul
          className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
          role="listbox"
        >
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
              onClick={() => {
                onChange('')
                setQuery('')
                setOpen(false)
              }}
            >
              {t('requests.computerPicker.unlinked')}
            </button>
          </li>
          {filtered.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-zinc-50/80"
                onClick={() => {
                  onChange(String(c.id))
                  setQuery(c.hostname)
                  setOpen(false)
                }}
              >
                {c.hostname}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">{t('requests.computerPicker.nothingFound')}</li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

export function userDirectoryLabel(u: UserDirectoryItem): string {
  return u.full_name ? `${u.full_name} (${u.username})` : u.username
}

/** Инициатор: выбор из справочника (локальные + LDAP в БД). */
export function DirectoryRequesterPicker({
  users,
  value,
  onChange,
  label,
  placeholder,
  labelClassName,
  inputClassName,
  hint,
  allowFreeText,
}: {
  users: UserDirectoryItem[]
  value: string
  onChange: (v: string) => void
  label: string
  placeholder?: string
  labelClassName?: string
  inputClassName?: string
  hint?: string | null
  allowFreeText?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(value)
  useEffect(() => setQuery(value), [value])

  const normalizedLabelMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users) {
      const lab = userDirectoryLabel(u)
      m.set(lab.trim().toLowerCase(), lab)
    }
    return m
  }, [users])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q
      ? users
      : users.filter(
          (u) =>
            u.username.toLowerCase().includes(q) || (u.full_name ?? '').toLowerCase().includes(q),
        )
    return list.slice(0, 120)
  }, [users, query])

  const resolveExactLabel = useCallback(
    (raw: string) => {
      const key = raw.trim().toLowerCase()
      return normalizedLabelMap.get(key) ?? null
    },
    [normalizedLabelMap],
  )

  return (
    <label className="block">
      <span className={labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]'}>
        {label}
      </span>
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            const v = e.target.value
            setQuery(v)
            if (allowFreeText) onChange(v)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setOpen(false), 150)
            if (allowFreeText) return
            const exact = resolveExactLabel(query)
            if (exact) {
              onChange(exact)
              setQuery(exact)
              return
            }
            // Не даём сохранить произвольный текст: возвращаем последнее валидное значение.
            setQuery(value)
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            if (allowFreeText) return
            e.preventDefault()
            const exact = resolveExactLabel(query)
            if (exact) {
              onChange(exact)
              setQuery(exact)
              setOpen(false)
              return
            }
            // Если нет точного совпадения, но есть варианты — берём первый.
            if (filtered.length) {
              const lab = userDirectoryLabel(filtered[0])
              onChange(lab)
              setQuery(lab)
              setOpen(false)
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
          className={
            inputClassName ??
            'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] shadow-sm placeholder:text-[var(--color-fg-subtle)] transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20'
          }
        />
        {open ? (
          <ul
            className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
            role="listbox"
          >
            <li>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange('')
                  setQuery('')
                  setOpen(false)
                }}
              >
                {t('requests.requesterPicker.clear')}
              </button>
            </li>
            {filtered.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg)] hover:bg-zinc-50/80"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    const lab = userDirectoryLabel(u)
                    onChange(lab)
                    setQuery(lab)
                    setOpen(false)
                  }}
                >
                  {userDirectoryLabel(u)}
                </button>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">{t('requests.requesterPicker.noMatches')}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {hint != null && hint !== '' ? <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">{hint}</p> : null}
    </label>
  )
}

/** Несколько ответственных: тот же паттерн, что у инициатора — поиск и список из справочника. */
export function DirectoryAssigneesPicker({
  users,
  selectedIds,
  onChange,
  label,
  labelClassName,
  inputClassName,
  hint,
  className,
  showSelectedChips = true,
}: {
  users: UserDirectoryItem[]
  selectedIds: number[]
  onChange: (ids: number[]) => void
  label?: string
  labelClassName?: string
  inputClassName?: string
  hint?: string | null
  className?: string
  showSelectedChips?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = !q
      ? users
      : users.filter(
          (u) =>
            u.username.toLowerCase().includes(q) || (u.full_name ?? '').toLowerCase().includes(q),
        )
    return list.slice(0, 120)
  }, [users, query])

  const toggle = (uid: number) => {
    if (selectedIds.includes(uid)) onChange(selectedIds.filter((x) => x !== uid))
    else onChange([...selectedIds, uid].sort((a, b) => a - b))
  }

  const selectedUsers = useMemo(
    () =>
      selectedIds
        .map((id) => users.find((u) => u.id === id))
        .filter((u): u is UserDirectoryItem => Boolean(u)),
    [users, selectedIds],
  )

  const inputCls =
    inputClassName ??
    'w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm text-[var(--color-fg)] shadow-sm placeholder:text-[var(--color-fg-subtle)] transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20'

  return (
    <div className={className ?? 'mb-3'}>
      <span
        className={
          labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]'
        }
      >
        {label ?? t('requests.assigneesPicker.label')}
      </span>
      {showSelectedChips && selectedUsers.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedUsers.map((u) => (
            <span
              key={u.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--color-surface-muted)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-fg)] ring-1 ring-slate-200/80"
            >
              <span className="truncate">{userDirectoryLabel(u)}</span>
              <button
                type="button"
                className="shrink-0 rounded-full px-1 leading-none text-[var(--color-fg-muted)] hover:bg-slate-200 hover:text-[var(--color-fg)]"
                onClick={() => toggle(u.id)}
                aria-label={t('requests.assigneesPicker.remove', { name: userDirectoryLabel(u) })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder={t('requests.assigneesPicker.placeholder')}
          autoComplete="off"
          className={inputCls}
        />
        {open ? (
          <ul
            className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
            role="listbox"
          >
            {selectedIds.length > 0 ? (
              <li>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onChange([])
                    setOpen(false)
                  }}
                >
                  {t('requests.assigneesPicker.clearAll')}
                </button>
              </li>
            ) : null}
            {filtered.map((u) => {
              const sel = selectedIds.includes(u.id)
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-50/80 ${sel ? 'bg-blue-50/40 font-semibold text-[var(--color-fg)]' : 'text-[var(--color-fg)]'}`}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggle(u.id)}
                  >
                    <span className="mr-2 inline-block w-4 text-center tabular-nums">{sel ? '✓' : ''}</span>
                    {userDirectoryLabel(u)}
                  </button>
                </li>
              )
            })}
            {users.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">{t('requests.assigneesPicker.noUsers')}</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--color-fg-subtle)]">{t('requests.assigneesPicker.noMatches')}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {hint != null && hint !== '' ? <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">{hint}</p> : null}
    </div>
  )
}

