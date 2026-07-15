import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'
import {
  api,
  type Computer,
  type DashboardSummary,
  type RequestCategoryTreeNode,
  type ServiceRequestRow,
  type ServiceRequestTemplateRow,
  type UserDirectoryItem,
} from '../api'
import { useAuth } from '../AuthContext'
import { IconPencil, IconTicket, IconTrash } from '../components/icons'
import { collectCategoryPaths, filterCategoryTree, flattenCategoryNodes } from '../requestCategories'
import { useLocale, useT, translateStatic } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

const REQUEST_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const
const REQUEST_PRIORITIES = ['low', 'normal', 'high'] as const

const CREATE_FORM_INPUT_CLS =
  'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-[13px] text-[var(--color-fg)] shadow-sm placeholder:text-[var(--color-fg-subtle)] transition focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_22%,transparent)]'
const CREATE_FORM_LABEL_CLS =
  'mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]'
const STATS_BASES = ['opened', 'last_change', 'closed'] as const
const STATS_GROUPS = ['day', 'week'] as const
const STATS_CHART_MODES = ['total', 'status'] as const

type RequestStatus = (typeof REQUEST_STATUSES)[number]
type RequestPriority = (typeof REQUEST_PRIORITIES)[number]
type StatsBasis = (typeof STATS_BASES)[number]
type StatsGroup = (typeof STATS_GROUPS)[number]
type StatsChartMode = (typeof STATS_CHART_MODES)[number]

const STATUS_PILL: Record<string, string> = {
  open: 'bg-blue-50 text-slate-950 ring-1 ring-blue-200/90',
  in_progress: 'bg-white text-neutral-950 ring-1 ring-neutral-200/90',
  done: 'bg-neutral-50 text-neutral-950 ring-1 ring-neutral-200/90',
  cancelled: 'bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200/90',
}

const RECENT_TITLE_KEY = 'service_request_recent_titles_v1'
const RECENT_TITLES_MAX = 8

type RequestsTabId = 'create' | 'database' | 'stats' | 'templates'

type SortKey = 'opened_desc' | 'closed_desc' | 'id_asc' | 'id_desc' | 'priority_desc'

function isRequestStatus(value: string): value is RequestStatus {
  return REQUEST_STATUSES.includes(value as RequestStatus)
}

function isRequestPriority(value: string): value is RequestPriority {
  return REQUEST_PRIORITIES.includes(value as RequestPriority)
}

function isStatsBasis(value: string): value is StatsBasis {
  return STATS_BASES.includes(value as StatsBasis)
}

function isStatsGroup(value: string): value is StatsGroup {
  return STATS_GROUPS.includes(value as StatsGroup)
}

function isStatsChartMode(value: string): value is StatsChartMode {
  return STATS_CHART_MODES.includes(value as StatsChartMode)
}

function sortArrow(active: boolean) {
  return <span className={`ml-1 ${active ? 'text-slate-600' : 'text-slate-300'}`}>{active ? '↓' : '↕'}</span>
}

function getAppScrollContainer(): HTMLElement | null {
  return document.querySelector('main')
}

type ListScrollRestore = { path: string; scrollTop: number; requestId: number }

let pendingListScrollRestore: ListScrollRestore | null = null
let skipNextListReload = false

function captureListScrollForRestore(requestId: number, path: string) {
  const el = getAppScrollContainer()
  if (!el) return
  pendingListScrollRestore = { path, scrollTop: el.scrollTop, requestId }
}

function scheduleListScrollRestore(expectedPath: string) {
  const saved = pendingListScrollRestore
  if (!saved || saved.path !== expectedPath) return

  const { scrollTop, requestId } = saved

  const tryApply = () => {
    if (!pendingListScrollRestore || pendingListScrollRestore.path !== expectedPath) return true

    const row = document.querySelector(`tr[data-request-id="${requestId}"]`)
    if (row instanceof HTMLElement) {
      row.scrollIntoView({ block: 'nearest' })
      pendingListScrollRestore = null
      return true
    }

    const main = getAppScrollContainer()
    if (main && main.scrollHeight >= scrollTop) {
      main.scrollTop = scrollTop
      pendingListScrollRestore = null
      return true
    }

    return false
  }

  if (tryApply()) return

  for (const ms of [0, 16, 50, 100, 200, 350, 500]) {
    window.setTimeout(() => {
      tryApply()
    }, ms)
  }
}

function readRecentTitles(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_TITLE_KEY)
    if (!raw) return []
    const a = JSON.parse(raw) as unknown
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(0, RECENT_TITLES_MAX) : []
  } catch {
    return []
  }
}

function pushRecentTitle(title: string) {
  const t = title.trim()
  if (!t) return
  const prev = readRecentTitles().filter((x) => x !== t)
  const next = [t, ...prev].slice(0, RECENT_TITLES_MAX)
  localStorage.setItem(RECENT_TITLE_KEY, JSON.stringify(next))
}

function removeRecentTitle(title: string) {
  const next = readRecentTitles().filter((x) => x !== title)
  localStorage.setItem(RECENT_TITLE_KEY, JSON.stringify(next))
}

/** Значение для input[type=datetime-local] в локальной зоне */
function parseIsoToDate(iso: string): Date | null {
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

function toDatetimeLocalValue(iso: string): string {
  const d = parseIsoToDate(iso)
  if (!d) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocalValue(s: string): string | null {
  const t = s.trim()
  if (!t) return null
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

function fmtRuDateTime(iso: string | null | undefined, locale: 'ru' | 'en'): string {
  if (!iso) return '—'
  try {
    const d = parseIsoToDate(iso)
    if (!d) return '—'
    return d.toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

function fmtRuShortDateTime(iso: string | null | undefined, locale: 'ru' | 'en'): string {
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

function requestStatusLabel(value: string): string {
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

function requestPriorityLabel(value: string): string {
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

function durationPresetLabel(minutes: number): string {
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

function requestPluralLabel(count: number): string {
  if (count === 1) return translateStatic('requests.stats.requestOne')
  if (count >= 2 && count <= 4) return translateStatic('requests.stats.requestFew')
  return translateStatic('requests.stats.requestMany')
}

/** Стабильный ID заявки в CORAX (не меняется при редактировании). */
function requestDisplayNo(r: { id: number; ticket_no?: number | null }): string {
  return String(r.id)
}

function compareRequestId(a: { id: number }, b: { id: number }, dir: 'asc' | 'desc'): number {
  return dir === 'asc' ? a.id - b.id : b.id - a.id
}

function pickLastChangeIso(r: ServiceRequestRow): string | null {
  return (r.glpi_updated_at ?? r.updated_at) || null
}

function CategoryPicker({
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
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
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
          className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20"
        />
        {value.trim() ? (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-100 hover:text-slate-800"
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
          className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          role="listbox"
        >
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
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
                    active ? 'bg-blue-50/70 text-slate-950' : 'text-slate-800 hover:bg-zinc-50/80'
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
                      <span className="ml-1 text-xs text-slate-400">({node.path})</span>
                    ) : null}
                  </span>
                </button>
              </li>
            )
          })}
          {flatFiltered.length === 0 && allPaths.length > 0 ? (
            <li className="px-3 py-2 text-sm text-slate-400">{t('requests.categoryPicker.nothingFound')}</li>
          ) : null}
        </ul>
      ) : null}
    </div>
  )
}

function defaultOpenedLocal(): string {
  return toDatetimeLocalValue(new Date().toISOString())
}

function defaultPlannedCloseLocal(): string {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  return toDatetimeLocalValue(d.toISOString())
}

function addMinutesToLocalDatetimeValue(localValue: string, minutes: number): string {
  const base = localValue.trim()
  const d = base ? new Date(base) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  d.setMinutes(d.getMinutes() + minutes)
  return toDatetimeLocalValue(d.toISOString())
}

// planned close UI removed (minimalistic create form)

// addDaysToLocalDatetimeValue removed (no planned close presets)

function topNWithOther(
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
const DONUT_COLORS = ['#0a0a0a', '#2563eb', '#404040', '#737373', '#1d4ed8', '#525252', '#a3a3a3', '#d4d4d4']

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}

function ringSlicePath(cx: number, cy: number, rOut: number, rIn: number, startDeg: number, endDeg: number) {
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

function DonutDistribution({
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
      <p className="rounded-xl border border-dashed border-neutral-200/90 bg-neutral-50/60 px-4 py-8 text-center text-sm text-neutral-500">
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
        </svg>
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-3 text-center" aria-live="polite">
          <div className={`flex w-full max-w-[7.5rem] flex-col items-center justify-center gap-0.5 ${compact ? 'min-h-[4.5rem]' : 'min-h-[5.25rem]'}`}>
            <span className={`admin-stat-value leading-none tracking-tight text-neutral-950 ${compact ? 'text-[1.35rem]' : 'text-[1.65rem]'}`}>
              {total}
            </span>
            <span className="text-[11px] font-medium text-neutral-500">{t('requests.charts.total')}</span>
          </div>
        </div>
      </div>
      <ul className={`min-w-0 ${centered ? '' : 'flex-1'} ${compact ? 'space-y-1.5 text-[13px]' : 'space-y-2'}`}>
        {normalizedItems.map((row, i) => {
          const pct = Math.round((row.count / total) * 100)
          const rowDim = hovered !== null && hovered !== i
          return (
            <li
              key={row.name}
              className={`flex cursor-default items-center gap-3 rounded-lg px-1 py-1.5 text-sm transition-colors ${
                hovered === i ? 'bg-neutral-50 ring-1 ring-neutral-200/70' : 'hover:bg-neutral-50'
              }`}
              style={{ opacity: rowDim ? 0.55 : 1 }}
              onMouseEnter={() => setHovered(i)}
            >
              <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm shadow-sm ring-1 ring-neutral-200/60" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
              <span className="min-w-0 flex-1 break-words text-[13px] font-medium leading-snug text-neutral-700">{row.name}</span>
              <span className="shrink-0 font-mono text-sm font-semibold text-neutral-900">{row.count}</span>
              <span className="shrink-0 text-xs tabular-nums text-neutral-400">({pct}%)</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function HorizontalBars({
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
      <div className="rounded-xl border border-dashed border-neutral-200/90 bg-neutral-50/60 px-4 py-6 text-center text-sm text-neutral-500">
        {t('requests.charts.noData')}
      </div>
    )
  }
  return (
    <div>
      <div className="mb-2 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">{title}</div>
      <div className="space-y-2">
        {items.map((item, i) => {
          const pct = Math.max(2, Math.round((item.count / total) * 100))
          return (
            <div key={`${item.name}-${i}`} className="space-y-1">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate font-medium text-slate-700">{item.name}</span>
                <span className="shrink-0 font-mono text-slate-900">{item.count}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-zinc-700" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const DURATION_PRESETS_MIN = [
  { minutes: 15, hotkey: 'Alt+1' },
  { minutes: 30, hotkey: 'Alt+2' },
  { minutes: 60, hotkey: 'Alt+3' },
  { minutes: 90, hotkey: 'Alt+4' },
] as const

function MiniStatCard({
  label,
  value,
  sub,
  icon,
  variant,
  compact,
}: {
  label: string
  value: string | number
  sub?: string
  icon: ReactNode
  variant: 'neutral' | 'danger'
  compact?: boolean
}) {
  const ring =
    variant === 'danger' ? 'ring-blue-200/80' : 'ring-neutral-200/90'
  const iconBg =
    variant === 'danger' ? 'bg-blue-50 text-slate-950' : 'bg-neutral-100 text-neutral-700'

  return (
    <div
      className={`rounded-xl border border-neutral-200/90 bg-white shadow-sm ring-1 ${ring} ${compact ? 'p-3' : 'p-4'}`}
    >
      <div className={`flex items-start ${compact ? 'gap-2.5' : 'gap-3'}`}>
        <div
          className={`flex shrink-0 items-center justify-center rounded-lg ${iconBg} ${compact ? 'h-9 w-9' : 'h-10 w-10'}`}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-neutral-500">{label}</div>
          <div
            className={`mt-0.5 font-[family-name:var(--font-display)] font-semibold tabular-nums tracking-tight text-neutral-950 ${compact ? 'text-xl' : 'text-2xl'}`}
          >
            {value}
          </div>
          {sub ? <div className="mt-1 text-[11px] font-medium text-neutral-500">{sub}</div> : null}
        </div>
      </div>
    </div>
  )
}

function ComputerPicker({
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
          labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500'
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
            'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400'
          }
        />
        {selected && (
          <button
            type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 text-xs text-slate-500 hover:bg-slate-100 hover:text-slate-800"
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
          className="absolute z-20 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
          role="listbox"
        >
          <li>
            <button
              type="button"
              className="w-full px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
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
                className="w-full px-3 py-2 text-left text-sm text-slate-800 hover:bg-zinc-50/80"
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
            <li className="px-3 py-2 text-sm text-slate-400">{t('requests.computerPicker.nothingFound')}</li>
          ) : null}
        </ul>
      )}
    </div>
  )
}

function userDirectoryLabel(u: UserDirectoryItem): string {
  return u.full_name ? `${u.full_name} (${u.username})` : u.username
}

/** Инициатор: выбор из справочника (локальные + LDAP в БД). */
function DirectoryRequesterPicker({
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
      <span className={labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500'}>
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
            'w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20'
          }
        />
        {open ? (
          <ul
            className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
            role="listbox"
          >
            <li>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
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
                  className="w-full px-3 py-2 text-left text-sm text-slate-800 hover:bg-zinc-50/80"
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
              <li className="px-3 py-2 text-sm text-slate-400">{t('requests.requesterPicker.noMatches')}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {hint != null && hint !== '' ? <p className="mt-1 text-[10px] text-slate-500">{hint}</p> : null}
    </label>
  )
}

/** Несколько ответственных: тот же паттерн, что у инициатора — поиск и список из справочника. */
function DirectoryAssigneesPicker({
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
    'w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20'

  return (
    <div className={className ?? 'mb-3'}>
      <span
        className={
          labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500'
        }
      >
        {label ?? t('requests.assigneesPicker.label')}
      </span>
      {showSelectedChips && selectedUsers.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selectedUsers.map((u) => (
            <span
              key={u.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-800 ring-1 ring-slate-200/80"
            >
              <span className="truncate">{userDirectoryLabel(u)}</span>
              <button
                type="button"
                className="shrink-0 rounded-full px-1 leading-none text-slate-500 hover:bg-slate-200 hover:text-slate-900"
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
            className="absolute z-30 mt-1 max-h-52 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-lg"
            role="listbox"
          >
            {selectedIds.length > 0 ? (
              <li>
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm text-slate-500 hover:bg-slate-50"
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
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-50/80 ${sel ? 'bg-blue-50/40 font-semibold text-slate-950' : 'text-slate-800'}`}
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
              <li className="px-3 py-2 text-sm text-slate-400">{t('requests.assigneesPicker.noUsers')}</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-400">{t('requests.assigneesPicker.noMatches')}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {hint != null && hint !== '' ? <p className="mt-1 text-[10px] text-slate-500">{hint}</p> : null}
    </div>
  )
}

export function ServiceRequestsPage() {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const DB_PAGE_SIZE = 100
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()
  const canManageRequests = Boolean(user?.is_superuser || user?.role === 'editor')

  const tab = useMemo<RequestsTabId>(() => {
    const p = location.pathname
    if (p === '/requests/database') return 'database'
    if (p === '/requests/stats') return 'stats'
    if (p === '/requests/templates') return 'templates'
    return 'create'
  }, [location.pathname])

  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [rows, setRows] = useState<ServiceRequestRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<string | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [dbShowAll, setDbShowAll] = useState(false)
  const [dbPage, setDbPage] = useState(1)

  const [pcList, setPcList] = useState<Computer[]>([])
  const [categoryTree, setCategoryTree] = useState<RequestCategoryTreeNode[]>([])
  const categoryPaths = useMemo(() => collectCategoryPaths(categoryTree), [categoryTree])
  const [userDir, setUserDir] = useState<UserDirectoryItem[]>([])
  const [recentTitles, setRecentTitles] = useState<string[]>(() =>
    typeof localStorage !== 'undefined' ? readRecentTitles() : [],
  )
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [showDescription, setShowDescription] = useState(false)
  const [requesterName, setRequesterName] = useState('')
  const [category, setCategory] = useState('')
  const [createStatus, setCreateStatus] = useState<RequestStatus>('open')
  const [priority, setPriority] = useState<RequestPriority>('normal')
  const [requestLocation, setRequestLocation] = useState('')
  const [openedAtLocal, setOpenedAtLocal] = useState(defaultOpenedLocal())
  const [plannedCloseLocal, setPlannedCloseLocal] = useState(defaultPlannedCloseLocal())
  const [closedAtLocal, setClosedAtLocal] = useState('')
  const [closedSameAsPlanned, setClosedSameAsPlanned] = useState(true)
  const [assigneeIds, setAssigneeIds] = useState<number[]>([])
  const [computerId, setComputerId] = useState('')
  const [createTemplateSelect, setCreateTemplateSelect] = useState('')
  const [saving, setSaving] = useState(false)

  const [tplRows, setTplRows] = useState<ServiceRequestTemplateRow[]>([])
  const [tplTotal, setTplTotal] = useState(0)
  const [tplLoading, setTplLoading] = useState(false)
  const [tplBusy, setTplBusy] = useState(false)
  const [tplTitle, setTplTitle] = useState('')
  const [tplDescription, setTplDescription] = useState('')
  const [tplStatus, setTplStatus] = useState<RequestStatus>('open')
  const [tplPriority, setTplPriority] = useState<RequestPriority>('normal')
  const [tplRequesterName, setTplRequesterName] = useState('')
  const [tplCategory, setTplCategory] = useState('')
  const [tplOpenedAtLocal, setTplOpenedAtLocal] = useState(defaultOpenedLocal())
  const [tplPlannedCloseLocal, setTplPlannedCloseLocal] = useState(defaultPlannedCloseLocal())
  const [tplClosedAtLocal, setTplClosedAtLocal] = useState('')
  const [tplClosedSameAsPlanned, setTplClosedSameAsPlanned] = useState(true)
  const [tplAssigneeIds, setTplAssigneeIds] = useState<number[]>([])
  const [tplComputerId, setTplComputerId] = useState('')
  const [tplEditingId, setTplEditingId] = useState<number | null>(null)

  const [datesEdit, setDatesEdit] = useState<{
    id: number
    opened: string
    planned: string
    closed: string
  } | null>(null)
  // dates editor removed from DB row UI (moved to modal later if needed)
  // const [datesBusy, setDatesBusy] = useState(false)

  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('id_desc')
  const [editingRequestId, setEditingRequestId] = useState<number | null>(null)
  const [editingReturnPath, setEditingReturnPath] = useState<string | null>(null)
  const [editDeleteConfirm, setEditDeleteConfirm] = useState(false)
  const [editDeleting, setEditDeleting] = useState(false)
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [reportOpen, setReportOpen] = useState(false)
  const [statsFrom, setStatsFrom] = useState<string>('')
  const [statsTo, setStatsTo] = useState<string>('')
  const [statsBasis, setStatsBasis] = useState<StatsBasis>('opened')
  const [statsGroup, setStatsGroup] = useState<StatsGroup>('day')
  const [statsChartMode, setStatsChartMode] = useState<StatsChartMode>('status')
  const [statsTopN, setStatsTopN] = useState(8)
  const [statsOnlyWithPlanned, setStatsOnlyWithPlanned] = useState(false)
  const [statsOnlyOverdue, setStatsOnlyOverdue] = useState(false)
  const [execReportTitle, setExecReportTitle] = useState(t('requests.reportDefaults.title'))
  const [execReportAudience, setExecReportAudience] = useState(t('requests.reportDefaults.audience'))
  const [execReportAuthor, setExecReportAuthor] = useState('')
  const filterTabs = useMemo(
    () => [
      { id: null, label: t('requests.tabs.all') },
      { id: 'open', label: t('requests.status.openPlural') },
      { id: 'in_progress', label: t('requests.status.inProgress') },
      { id: 'done', label: t('requests.status.donePlural') },
      { id: 'cancelled', label: t('requests.status.cancelledPlural') },
    ],
    [t],
  )

  const [execIncludeNarrative, setExecIncludeNarrative] = useState(true)
  const [execIncludeChart, setExecIncludeChart] = useState(true)
  const [execIncludeDistributions, setExecIncludeDistributions] = useState(true)
  const [execIncludeAssigneeLoad, setExecIncludeAssigneeLoad] = useState(true)

  const createFormAssignees = useMemo(
    () =>
      assigneeIds
        .map((id) => userDir.find((u) => u.id === id))
        .filter((u): u is UserDirectoryItem => Boolean(u)),
    [assigneeIds, userDir],
  )

  const sortHint = useCallback(
    (asc: SortKey, desc?: SortKey) => {
      // If only one key is provided (e.g. *_desc), show "↓" when active, otherwise "↕".
      if (!desc) return sortArrow(sortKey === asc)
      // If asc/desc pair is provided, show ↑ or ↓ depending on active key, otherwise ↕.
      if (sortKey === asc) return <span className="ml-1 text-slate-600">↑</span>
      if (sortKey === desc) return <span className="ml-1 text-slate-600">↓</span>
      return <span className="ml-1 text-slate-300">↕</span>
    },
    [sortKey],
  )

  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await api.dashboardSummary())
    } catch {
      setSummary(null)
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  // old lightweight stats replaced by "statsRows/statsSeries" above

  const statsRows = useMemo(() => {
    const from = statsFrom.trim()
    const to = statsTo.trim()
    const fromMs = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity
    const toMs = to ? new Date(`${to}T23:59:59`).getTime() : Infinity
    const now = Date.now()

    const basisIso = (r: ServiceRequestRow) => {
      if (statsBasis === 'closed') return r.closed_at ?? null
      if (statsBasis === 'last_change') return pickLastChangeIso(r)
      return r.opened_at ?? r.created_at
    }

    return rows.filter((r) => {
      const iso = basisIso(r)
      const d = iso ? parseIsoToDate(iso) : null
      const t = d ? d.getTime() : NaN
      if (!Number.isFinite(t)) return false
      if (t < fromMs || t > toMs) return false
      if (statsOnlyWithPlanned && !r.planned_close_at) return false
      if (statsOnlyOverdue) {
        if (!r.planned_close_at) return false
        const p = parseIsoToDate(r.planned_close_at)
        if (!p) return false
        if (!(p.getTime() < now && !r.closed_at && r.status !== 'done' && r.status !== 'cancelled')) return false
      }
      return true
    })
  }, [rows, statsBasis, statsFrom, statsOnlyOverdue, statsOnlyWithPlanned, statsTo])

  const statsSeries = useMemo(() => {
    const m = new Map<string, { total: number; byStatus: Record<string, number> }>()
    const keyOf = (d: Date) => {
      if (statsGroup === 'week') {
        // ISO week key: YYYY-Www (roughly enough for UI)
        const tmp = new Date(d)
        tmp.setHours(0, 0, 0, 0)
        // Thursday in current week decides the year
        tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7))
        const week1 = new Date(tmp.getFullYear(), 0, 4)
        const week = 1 + Math.round(((tmp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
        return `${tmp.getFullYear()}-W${String(week).padStart(2, '0')}`
      }
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const basisIso = (r: ServiceRequestRow) => {
      if (statsBasis === 'closed') return r.closed_at ?? null
      if (statsBasis === 'last_change') return pickLastChangeIso(r)
      return r.opened_at ?? r.created_at
    }
    for (const r of statsRows) {
      const iso = basisIso(r)
      const d = iso ? parseIsoToDate(iso) : null
      if (!d) continue
      const k = keyOf(d)
      const cur = m.get(k) ?? { total: 0, byStatus: {} }
      cur.total += 1
      cur.byStatus[r.status] = (cur.byStatus[r.status] ?? 0) + 1
      m.set(k, cur)
    }
    const items = [...m.entries()]
      .map(([k, v]) => ({ key: k, ...v }))
      .sort((a, b) => a.key.localeCompare(b.key))
    const max = Math.max(1, ...items.map((x) => x.total))
    return { items, max }
  }, [statsBasis, statsGroup, statsRows])

  const statsCategoryItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const k = r.category ?? '—'
        acc.set(k, (acc.get(k) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()].map(([name, count]) => ({ name, count })),
    [statsRows],
  )

  const statsRequesterItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const k = r.requester_name ?? '—'
        acc.set(k, (acc.get(k) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()].map(([name, count]) => ({ name, count })),
    [statsRows],
  )

  const statsAssigneeItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const arr = r.assignee_usernames?.length ? r.assignee_usernames : [t('requests.statsData.noAssignee')]
        for (const n of arr) acc.set(n, (acc.get(n) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    [statsRows, t],
  )

  const statsPriorityItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const p = requestPriorityLabel(r.priority)
        acc.set(p, (acc.get(p) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()].map(([name, count]) => ({ name, count })),
    [statsRows, t],
  )

  const statsStatusItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const s = requestStatusLabel(r.status)
        acc.set(s, (acc.get(s) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()].map(([name, count]) => ({ name, count })),
    [statsRows, t],
  )

  const statsKpi = useMemo(() => {
    const total = statsRows.length
    const done = statsRows.filter((r) => r.status === 'done').length
    const active = statsRows.filter((r) => r.status === 'open' || r.status === 'in_progress').length
    const overdue = statsRows.filter((r) => {
      if (!r.planned_close_at) return false
      const p = parseIsoToDate(r.planned_close_at)
      if (!p) return false
      return p.getTime() < Date.now() && !r.closed_at && r.status !== 'done' && r.status !== 'cancelled'
    }).length
    const completionRate = total > 0 ? Math.round((done / total) * 100) : 0
    const overdueRate = total > 0 ? Math.round((overdue / total) * 100) : 0
    const closedDurations = statsRows
      .map((r) => {
        const opened = parseIsoToDate(r.opened_at ?? r.created_at)
        const closed = parseIsoToDate(r.closed_at ?? '')
        if (!opened || !closed) return null
        const h = (closed.getTime() - opened.getTime()) / 3_600_000
        return Number.isFinite(h) && h >= 0 ? h : null
      })
      .filter((v): v is number => v != null)
    const avgCloseHours = closedDurations.length
      ? Math.round((closedDurations.reduce((a, b) => a + b, 0) / closedDurations.length) * 10) / 10
      : null
    const closedWithPlan = statsRows.filter((r) => r.closed_at && r.planned_close_at)
    const inSla = closedWithPlan.filter((r) => {
      const p = parseIsoToDate(r.planned_close_at ?? '')
      const c = parseIsoToDate(r.closed_at ?? '')
      return Boolean(p && c && c.getTime() <= p.getTime())
    }).length
    const slaHitRate = closedWithPlan.length ? Math.round((inSla / closedWithPlan.length) * 100) : 0
    return { total, done, active, overdue, completionRate, overdueRate, avgCloseHours, slaHitRate }
  }, [statsRows])

  const statsPeriodLabel = useMemo(() => {
    const from = statsFrom.trim() || t('requests.statsData.noDataStart')
    const to = statsTo.trim() || t('requests.statsData.today')
    return `${from} - ${to}`
  }, [statsFrom, statsTo, t])

  const statsLineChart = useMemo(() => {
    const labels = statsSeries.items.map((x) => x.key)
    const data = statsSeries.items.map((x) => x.total)
    const statusDatasetDefs = [
      { key: 'open', label: t('requests.statsData.openSeries'), color: '#2563eb', bg: 'rgb(37 99 235 / 0.1)' },
      { key: 'in_progress', label: t('requests.statsData.inProgressSeries'), color: '#0f172a', bg: 'rgb(15 23 42 / 0.1)' },
      { key: 'done', label: t('requests.statsData.doneSeries'), color: '#334155', bg: 'rgb(51 65 85 / 0.1)' },
      { key: 'cancelled', label: t('requests.statsData.cancelledSeries'), color: '#64748b', bg: 'rgb(100 116 139 / 0.1)' },
    ] as const
    const statusDatasets =
      statsChartMode === 'status'
        ? statusDatasetDefs
            .map((d) => ({
              label: d.label,
              data: statsSeries.items.map((x) => Number(x.byStatus[d.key] ?? 0)),
              borderColor: d.color,
              backgroundColor: d.bg,
              pointRadius: 2,
              tension: 0.22,
            }))
            // Professional look: hide zero-only status lines (e.g. no open tickets).
            .filter((ds) => ds.data.some((v) => v > 0))
        : []
    return {
      data: {
        labels,
        datasets:
          statsChartMode === 'status'
            ? statusDatasets
            : [
                {
                  label: t('requests.statsData.requestsSeries'),
                  data,
                  borderColor: 'rgb(37 99 235)',
                  backgroundColor: 'rgb(37 99 235 / 0.12)',
                  pointRadius: 3,
                  pointHoverRadius: 5,
                  tension: 0.25,
                  fill: true,
                },
              ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: statsChartMode === 'status' && statusDatasets.length > 0 },
          tooltip: { enabled: true },
        },
        scales: {
          x: { ticks: { maxRotation: 0, autoSkip: true } },
          y: { beginAtZero: true, ticks: { precision: 0 } },
        },
      } as const,
    }
  }, [statsChartMode, statsSeries.items, t])

  const visibleRows = useMemo(() => {
    const qRaw = query.trim()
    const q = qRaw.toLowerCase()
    const qId = (() => {
      const t = qRaw.replace(/^#/, '').trim()
      if (!t) return null
      const n = Number.parseInt(t, 10)
      return Number.isFinite(n) ? n : null
    })()

    const filteredBySearch = !q
      ? rows
      : rows.filter((r) => {
          if (qId != null && (r.id === qId || r.glpi_id === qId || r.ticket_no === qId)) return true
          const parts = [
            String(r.id),
            r.ticket_no != null ? String(r.ticket_no) : '',
            r.glpi_id != null ? String(r.glpi_id) : '',
            r.title ?? '',
            r.requester_name ?? '',
            r.category ?? '',
            r.computer_hostname ?? '',
            r.glpi_status ?? '',
            r.glpi_priority ?? '',
          ]
          return parts.join(' | ').toLowerCase().includes(q)
        })

    const filtered =
      filterCategory.trim()
        ? filteredBySearch.filter((r) => (r.category ?? '').startsWith(filterCategory.trim()))
        : filteredBySearch

    const prioRank = (p: string) => (p === 'high' ? 3 : p === 'normal' ? 2 : p === 'low' ? 1 : 0)
    const ts = (iso: string | null | undefined) => {
      if (!iso) return -Infinity
      const d = parseIsoToDate(iso)
      return d ? d.getTime() : -Infinity
    }

    return filtered.slice().sort((a, b) => {
      if (sortKey === 'opened_desc') {
        const ka = ts(a.opened_at ?? a.created_at)
        const kb = ts(b.opened_at ?? b.created_at)
        if (kb !== ka) return kb - ka
        return b.id - a.id
      }
      if (sortKey === 'closed_desc') {
        const closeIso = (r: ServiceRequestRow) => r.closed_at ?? r.planned_close_at
        const ka = ts(closeIso(a))
        const kb = ts(closeIso(b))
        if (kb !== ka) return kb - ka
        return b.id - a.id
      }
      if (sortKey === 'id_asc') return compareRequestId(a, b, 'asc')
      if (sortKey === 'id_desc') return compareRequestId(a, b, 'desc')
      if (sortKey === 'priority_desc') {
        const ka = prioRank(a.priority)
        const kb = prioRank(b.priority)
        if (kb !== ka) return kb - ka
        return compareRequestId(a, b, 'desc')
      }
      return compareRequestId(a, b, 'desc')
    })
  }, [filterCategory, query, rows, sortKey])

  const dbPageCount = useMemo(
    () => Math.max(1, Math.ceil(visibleRows.length / DB_PAGE_SIZE)),
    [visibleRows.length, DB_PAGE_SIZE],
  )

  const dbRowsToRender = useMemo(() => {
    if (tab !== 'database') return visibleRows
    const p = Math.min(dbPage, dbPageCount)
    const start = (p - 1) * DB_PAGE_SIZE
    return visibleRows.slice(start, start + DB_PAGE_SIZE)
  }, [tab, visibleRows, dbPage, dbPageCount, DB_PAGE_SIZE])

  const load = useCallback(async () => {
    if (skipNextListReload && (tab === 'database' || tab === 'stats')) {
      skipNextListReload = false
      return
    }
    setLoading(true)
    try {
      const needAll = tab === 'stats'
      const r = await api.serviceRequests({
        limit: needAll ? 1000 : dbShowAll ? 1000 : 200,
        ...(filterStatus ? { status: filterStatus } : {}),
      })
      setRows(r.items)
      setTotal(r.total)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setLoading(false)
    }
  }, [dbShowAll, filterStatus, tab, t, toast])

  const loadTemplates = useCallback(async () => {
    setTplLoading(true)
    try {
      const r = await api.serviceRequestTemplates({ limit: 300 })
      setTplRows(r.items)
      setTplTotal(r.total)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
      setTplRows([])
      setTplTotal(0)
    } finally {
      setTplLoading(false)
    }
  }, [t])

  useEffect(() => {
    void refreshSummary()
  }, [refreshSummary])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (loading) return
    if (tab !== 'database' && tab !== 'stats') return
    scheduleListScrollRestore(location.pathname)
  }, [loading, tab, location.pathname, visibleRows.length])

  useEffect(() => {
    if (tab === 'database') {
      setDbPage(1)
    }
  }, [tab, query, filterCategory, filterStatus, sortKey])

  useEffect(() => {
    if (dbPage > dbPageCount) setDbPage(dbPageCount)
  }, [dbPage, dbPageCount])

  useEffect(() => {
    if (tab !== 'create' && tab !== 'templates') return
    void (async () => {
      try {
        const r = await api.computers({ limit: 500 })
        setPcList(r.items)
      } catch {
        setPcList([])
      }
    })()
  }, [tab])

  useEffect(() => {
    void (async () => {
      try {
        setCategoryTree(await api.requestCategories())
      } catch {
        setCategoryTree([])
      }
    })()
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        setUserDir(await api.usersDirectory())
      } catch {
        setUserDir([])
      }
    })()
  }, [])

  useEffect(() => {
    if (tab !== 'templates' && tab !== 'create') return
    void loadTemplates()
  }, [tab, loadTemplates])

  // Hotkeys for fast duration planning (Alt+1..4)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
      const map: Record<string, number> = { '1': 15, '2': 30, '3': 60, '4': 90 }
      const mins = map[e.key]
      if (!mins) return
      e.preventDefault()
      if (tab === 'create') {
        setPlannedCloseLocal((prev) => addMinutesToLocalDatetimeValue(openedAtLocal, mins) || prev)
      }
      if (tab === 'templates') {
        setTplPlannedCloseLocal((prev) => addMinutesToLocalDatetimeValue(tplOpenedAtLocal, mins) || prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openedAtLocal, tab, tplOpenedAtLocal])

  useEffect(() => {
    if (!closedSameAsPlanned) return
    setClosedAtLocal(plannedCloseLocal)
    if (plannedCloseLocal.trim()) {
      setCreateStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
    }
  }, [closedSameAsPlanned, plannedCloseLocal])

  useEffect(() => {
    if (!tplClosedSameAsPlanned) return
    setTplClosedAtLocal(tplPlannedCloseLocal)
    if (tplPlannedCloseLocal.trim()) {
      setTplStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
    }
  }, [tplClosedSameAsPlanned, tplPlannedCloseLocal])

  function resetCreateFormAfterSubmit() {
    setCreateStatus('open')
    setPriority('normal')
    setRequestLocation('')
    setOpenedAtLocal(defaultOpenedLocal())
    setPlannedCloseLocal(defaultPlannedCloseLocal())
    setClosedAtLocal('')
    setClosedSameAsPlanned(true)
    setAssigneeIds([])
    setComputerId('')
    setRequesterName('')
    setCategory('')
    setShowDescription(false)
    setEditingRequestId(null)
    setEditingReturnPath(null)
    setEditDeleteConfirm(false)
  }

  function populateFormFromRequest(t: ServiceRequestRow) {
    setTitle(t.title ?? '')
    setDescription(t.description ?? '')
    setShowDescription(Boolean(t.description?.trim()))
    setRequesterName((t.requester_name ?? '').trim())
    setCategory((t.category ?? '').trim())
    setRequestLocation((t.location ?? '').trim())
    setCreateStatus(isRequestStatus(t.status) ? t.status : 'open')
    setPriority(isRequestPriority(t.priority) ? t.priority : 'normal')
    setAssigneeIds(Array.isArray(t.assignee_ids) ? [...t.assignee_ids] : [])
    setComputerId(t.computer_id != null ? String(t.computer_id) : '')
    setOpenedAtLocal(
      t.opened_at
        ? toDatetimeLocalValue(t.opened_at)
        : t.created_at
          ? toDatetimeLocalValue(t.created_at)
          : defaultOpenedLocal(),
    )
    const planned = t.planned_close_at ? toDatetimeLocalValue(t.planned_close_at) : ''
    const closed = t.closed_at ? toDatetimeLocalValue(t.closed_at) : ''
    setPlannedCloseLocal(planned)
    setClosedAtLocal(closed)
    setClosedSameAsPlanned(
      (!closed && !planned) || (!closed && Boolean(planned)) || Boolean(closed && planned && closed === planned),
    )
  }

  function navigateBackToList(returnPath: string | null) {
    if (!returnPath || returnPath === '/requests') return
    skipNextListReload = true
    navigate(returnPath)
    scheduleListScrollRestore(returnPath)
  }

  function openRequestForEdit(t: ServiceRequestRow) {
    captureListScrollForRestore(t.id, location.pathname)
    populateFormFromRequest(t)
    setEditingRequestId(t.id)
    setEditingReturnPath(location.pathname)
    setEditDeleteConfirm(false)
    navigate('/requests')
    window.requestAnimationFrame(() => {
      const el = getAppScrollContainer()
      if (el) el.scrollTop = 0
    })
  }

  function cancelEditing() {
    const returnPath = editingReturnPath
    setTitle('')
    setDescription('')
    resetCreateFormAfterSubmit()
    navigateBackToList(returnPath)
  }

  async function onSubmitRequest(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    try {
      const closedLocalValue = closedSameAsPlanned ? plannedCloseLocal : closedAtLocal
      const closedParsed = closedLocalValue.trim() ? fromDatetimeLocalValue(closedLocalValue) : null
      let effectiveStatus = createStatus
      if (closedParsed) {
        effectiveStatus = createStatus === 'cancelled' ? 'cancelled' : 'done'
      }
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        status: effectiveStatus,
        priority,
        location: requestLocation.trim() || null,
        requester_name: requesterName.trim() || null,
        category: category.trim() || null,
        computer_id: computerId ? Number(computerId) : null,
        assignee_ids: assigneeIds,
        opened_at: fromDatetimeLocalValue(openedAtLocal),
        planned_close_at: plannedCloseLocal.trim() ? fromDatetimeLocalValue(plannedCloseLocal) : null,
        closed_at: closedParsed ?? undefined,
      }

      if (editingRequestId != null) {
        const updated = await api.updateServiceRequest(editingRequestId, {
          ...body,
          closed_at: closedParsed,
        })
        const returnPath = editingReturnPath
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
        setTitle('')
        setDescription('')
        resetCreateFormAfterSubmit()
        toast.ok(t('requests.messages.saved'))
        void refreshSummary()
        if (returnPath && returnPath !== '/requests') navigateBackToList(returnPath)
      } else {
        await api.createServiceRequest(body)
        pushRecentTitle(title.trim())
        setRecentTitles(readRecentTitles())
        setTitle('')
        setDescription('')
        resetCreateFormAfterSubmit()
        toast.ok(t('requests.messages.created'))
        await load()
        void refreshSummary()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setSaving(false)
    }
  }

  async function downloadPdf() {
    setPdfBusy(true)
    try {
      await api.exportServiceRequestsPdf({ status: filterStatus, limit: dbShowAll ? 2000 : 400 })
      toast.ok(t('requests.messages.pdfSaved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setPdfBusy(false)
    }
  }

  function escapeHtml(v: string): string {
    return v
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  async function downloadExecutivePdf() {
    try {
      const chartCanvas = document.querySelector('.stats-report canvas') as HTMLCanvasElement | null
      const chartImage = chartCanvas ? chartCanvas.toDataURL('image/png', 1.0) : null
      const categoryTop = topNWithOther(statsCategoryItems, statsTopN, 'Остальные категории').slice(0, statsTopN)
      const requesterTop = topNWithOther(statsRequesterItems, statsTopN, 'Остальные пользователи').slice(0, statsTopN)
      const assigneeTop = topNWithOther(statsAssigneeItems, statsTopN, 'Остальные исполнители').slice(0, statsTopN)
      const statusTop = topNWithOther(statsStatusItems, 6, 'Другие статусы')
      const priorityTop = topNWithOther(statsPriorityItems, 6, 'Другие')
      const nowText = new Date().toLocaleString('ru-RU')
      const title = execReportTitle.trim() || 'Отчет по заявкам'
      const subtitle = `Период: ${statsPeriodLabel}`
      const basisText =
        statsBasis === 'opened'
          ? 'дата открытия'
          : statsBasis === 'closed'
            ? 'фактическая дата закрытия'
            : 'последнее изменение'
      const groupText = statsGroup === 'day' ? 'по дням' : 'по неделям'
      const narrative = [
        `За выбранный период зарегистрировано ${statsKpi.total} заявок, из них закрыто ${statsKpi.done} (${statsKpi.completionRate}%).`,
        `Просроченных обращений: ${statsKpi.overdue} (${statsKpi.overdueRate}%).`,
        `Среднее время закрытия: ${statsKpi.avgCloseHours != null ? `${statsKpi.avgCloseHours} ч` : 'н/д'}, SLA в срок: ${statsKpi.slaHitRate}%.`,
      ]

      const listHtml = (items: { name: string; count: number }[], totalForPct: number) =>
        items
          .map((i) => {
            const pct = totalForPct > 0 ? Math.round((i.count / totalForPct) * 100) : 0
            return `<tr><td>${escapeHtml(i.name)}</td><td>${i.count}</td><td>${pct}%</td></tr>`
          })
          .join('')

      const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { size: A4 portrait; margin: 12mm; }
      body { margin: 0; font-family: Inter, Arial, sans-serif; color: #0f172a; }
      .page { width: 100%; }
      .head { border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; background: #fff; }
      .h1 { margin: 0; font-size: 20px; font-weight: 700; }
      .muted { color: #64748b; font-size: 12px; margin-top: 4px; }
      .meta { margin-top: 6px; font-size: 12px; color: #475569; }
      .kpi-grid { margin-top: 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .kpi { border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; background: #fff; }
      .kpi .label { font-size: 10px; text-transform: uppercase; color: #64748b; letter-spacing: .06em; }
      .kpi .value { margin-top: 4px; font-size: 21px; font-weight: 700; }
      .kpi .sub { margin-top: 2px; font-size: 11px; color: #64748b; }
      .sec { margin-top: 12px; border: 1px solid #e2e8f0; border-radius: 10px; padding: 10px; page-break-inside: avoid; }
      .sec h2 { margin: 0 0 8px 0; font-size: 14px; }
      .narrative { margin: 0; padding-left: 16px; font-size: 12px; line-height: 1.45; }
      .chart-wrap { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; background: #fff; }
      .chart-wrap img { width: 100%; height: auto; display: block; }
      .grid2 { margin-top: 12px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th, td { border: 1px solid #e2e8f0; padding: 6px; text-align: left; vertical-align: top; }
      th { background: #f8fafc; font-weight: 600; }
      .foot { margin-top: 10px; font-size: 10px; color: #94a3b8; text-align: right; }
    </style>
  </head>
  <body>
    <div class="page">
      <section class="head">
        <h1 class="h1">${escapeHtml(title)}</h1>
        <div class="muted">${escapeHtml(subtitle)}${execReportAudience.trim() ? ` · ${escapeHtml(execReportAudience.trim())}` : ''}</div>
        <div class="meta">Основание дат: ${escapeHtml(basisText)} · Группировка: ${escapeHtml(groupText)} · Сформировано: ${escapeHtml(nowText)}</div>
        ${execReportAuthor.trim() ? `<div class="meta">Подготовил: ${escapeHtml(execReportAuthor.trim())}</div>` : ''}
        <div class="kpi-grid">
          <div class="kpi"><div class="label">Всего заявок</div><div class="value">${statsKpi.total}</div><div class="sub">в выбранном периоде</div></div>
          <div class="kpi"><div class="label">Закрыто</div><div class="value">${statsKpi.done}</div><div class="sub">${statsKpi.completionRate}% от всех</div></div>
          <div class="kpi"><div class="label">Просрочено</div><div class="value">${statsKpi.overdue}</div><div class="sub">${statsKpi.overdueRate}% от всех</div></div>
          <div class="kpi"><div class="label">Среднее закрытие</div><div class="value">${statsKpi.avgCloseHours != null ? `${statsKpi.avgCloseHours} ч` : '—'}</div><div class="sub">от открытия до закрытия</div></div>
          <div class="kpi"><div class="label">SLA в срок</div><div class="value">${statsKpi.slaHitRate}%</div><div class="sub">закрытые <= плановой даты</div></div>
          <div class="kpi"><div class="label">Активные</div><div class="value">${statsKpi.active}</div><div class="sub">open + in_progress</div></div>
        </div>
      </section>
      ${execIncludeNarrative ? `<section class="sec">
        <h2>Выводы для руководства</h2>
        <ul class="narrative">${narrative.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
      </section>` : ''}
      ${execIncludeChart ? `<section class="sec">
        <h2>Динамика обращений</h2>
        ${chartImage ? `<div class="chart-wrap"><img src="${chartImage}" alt="График динамики"/></div>` : '<div class="muted">График недоступен для выгрузки.</div>'}
      </section>` : ''}
      ${execIncludeDistributions ? `<section class="grid2">
        <div class="sec">
          <h2>Топ категорий</h2>
          <table><thead><tr><th>Категория</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${listHtml(categoryTop, Math.max(1, statsRows.length))}</tbody></table>
        </div>
        <div class="sec">
          <h2>Топ инициаторов</h2>
          <table><thead><tr><th>Инициатор</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${listHtml(requesterTop, Math.max(1, statsRows.length))}</tbody></table>
        </div>
      </section>
      <section class="grid2">
        <div class="sec">
          <h2>Статусы</h2>
          <table><thead><tr><th>Статус</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${listHtml(statusTop, Math.max(1, statsRows.length))}</tbody></table>
        </div>
        <div class="sec">
          <h2>Приоритеты</h2>
          <table><thead><tr><th>Приоритет</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${listHtml(priorityTop, Math.max(1, statsRows.length))}</tbody></table>
        </div>
      </section>` : ''}
      ${execIncludeAssigneeLoad ? `<section class="sec">
        <h2>Нагрузка по исполнителям</h2>
        <table><thead><tr><th>Исполнитель</th><th>Кол-во</th><th>%</th></tr></thead><tbody>${listHtml(assigneeTop, Math.max(1, assigneeTop.reduce((a, b) => a + b.count, 0)))}</tbody></table>
      </section>` : ''}
      <div class="foot">CORAX · Executive Report</div>
    </div>
  </body>
</html>`

      const w = window.open('about:blank', '_blank', 'width=1100,height=900')
      if (!w) {
        toast.error(t('requests.errors.popupBlocked'))
        return
      }
      try {
        w.document.open()
        w.document.write(html)
        w.document.close()
        w.focus()
        window.setTimeout(() => {
          w.print()
        }, 280)
      } catch {
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const wb = window.open(url, '_blank')
        if (!wb) {
          toast.error(t('requests.errors.reportWindow'))
          URL.revokeObjectURL(url)
          return
        }
        window.setTimeout(() => {
          wb.focus()
          wb.print()
          URL.revokeObjectURL(url)
        }, 450)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.execPdf'))
    }
  }

  async function removeEditingRequest() {
    if (editingRequestId == null || editDeleting) return
    setEditDeleting(true)
    try {
      await api.deleteServiceRequest(editingRequestId)
      const id = editingRequestId
      if (datesEdit?.id === id) setDatesEdit(null)
      const returnPath = editingReturnPath
      setTitle('')
      setDescription('')
      resetCreateFormAfterSubmit()
      toast.ok(t('requests.messages.deleted'))
      await load()
      void refreshSummary()
      if (returnPath && returnPath !== '/requests') navigateBackToList(returnPath)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.delete'))
    } finally {
      setEditDeleting(false)
    }
  }

  function applyTemplateToForm(template: ServiceRequestTemplateRow) {
    setTitle(template.title)
    setDescription(template.description ?? '')
    setShowDescription(Boolean(template.description))
    setCreateStatus(isRequestStatus(template.status) ? template.status : 'open')
    setPriority(isRequestPriority(template.priority) ? template.priority : 'normal')
    setAssigneeIds(Array.isArray(template.assignee_ids) ? template.assignee_ids : [])
    setComputerId(template.computer_id ? String(template.computer_id) : '')
    setRequesterName((template.requester_name ?? '').trim())
    setCategory((template.category ?? '').trim())
    setOpenedAtLocal(
      template.opened_at ? toDatetimeLocalValue(template.opened_at) : defaultOpenedLocal(),
    )
    const planned = template.planned_close_at
      ? toDatetimeLocalValue(template.planned_close_at)
      : defaultPlannedCloseLocal()
    const closed = template.closed_at ? toDatetimeLocalValue(template.closed_at) : ''
    setPlannedCloseLocal(planned)
    setClosedAtLocal(closed)
    setClosedSameAsPlanned(Boolean(closed && planned && closed === planned))
    navigate('/requests')
    toast.info(t('requests.messages.templateApplied', { title: template.title }))
  }

  function resetTemplateForm() {
    setTplEditingId(null)
    setTplTitle('')
    setTplDescription('')
    setTplRequesterName('')
    setTplCategory('')
    setTplAssigneeIds([])
    setTplComputerId('')
    setTplStatus('open')
    setTplPriority('normal')
    setTplOpenedAtLocal(defaultOpenedLocal())
    setTplPlannedCloseLocal(defaultPlannedCloseLocal())
    setTplClosedAtLocal('')
    setTplClosedSameAsPlanned(true)
  }

  function beginEditTemplate(t: ServiceRequestTemplateRow) {
    setTplEditingId(t.id)
    setTplTitle(t.title)
    setTplDescription(t.description ?? '')
    setTplStatus(isRequestStatus(t.status) ? t.status : 'open')
    setTplPriority(isRequestPriority(t.priority) ? t.priority : 'normal')
    setTplRequesterName((t.requester_name ?? '').trim())
    setTplCategory((t.category ?? '').trim())
    setTplAssigneeIds(Array.isArray(t.assignee_ids) ? [...t.assignee_ids] : [])
    setTplComputerId(t.computer_id ? String(t.computer_id) : '')
    setTplOpenedAtLocal(t.opened_at ? toDatetimeLocalValue(t.opened_at) : defaultOpenedLocal())
    const planned = t.planned_close_at ? toDatetimeLocalValue(t.planned_close_at) : defaultPlannedCloseLocal()
    const closed = t.closed_at ? toDatetimeLocalValue(t.closed_at) : ''
    setTplPlannedCloseLocal(planned)
    setTplClosedAtLocal(closed)
    setTplClosedSameAsPlanned(Boolean(closed && planned && closed === planned))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function saveTemplateFromForm() {
    if (!tplTitle.trim()) return
    setTplBusy(true)
    try {
      const tplClosedLocalValue = tplClosedSameAsPlanned ? tplPlannedCloseLocal : tplClosedAtLocal
      const body = {
        title: tplTitle.trim(),
        description: tplDescription.trim() || null,
        status: tplStatus,
        priority: tplPriority,
        requester_name: tplRequesterName.trim() || null,
        category: tplCategory.trim() || null,
        computer_id: tplComputerId ? Number(tplComputerId) : null,
        assignee_ids: tplAssigneeIds,
        opened_at: fromDatetimeLocalValue(tplOpenedAtLocal),
        planned_close_at: fromDatetimeLocalValue(tplPlannedCloseLocal),
        closed_at: tplClosedLocalValue.trim() ? fromDatetimeLocalValue(tplClosedLocalValue) : null,
      }
      if (tplEditingId != null) {
        await api.updateServiceRequestTemplate(tplEditingId, body)
        toast.ok(t('requests.messages.templateUpdated'))
      } else {
        await api.createServiceRequestTemplate(body)
        toast.ok(t('requests.messages.templateSaved'))
      }
      resetTemplateForm()
      await loadTemplates()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setTplBusy(false)
    }
  }

  async function deleteTemplate(id: number, title: string) {
    if (!window.confirm(`Удалить шаблон «${title}»?`)) return
    setTplBusy(true)
    try {
      await api.deleteServiceRequestTemplate(id)
      if (tplEditingId === id) resetTemplateForm()
      toast.ok('Шаблон удалён')
      await loadTemplates()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setTplBusy(false)
    }
  }

  // startDatesEdit/saveDatesEdit removed (will re-introduce in modal if required)

  return (
    <div>
      <div className="app-panel mb-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
          <div className="page-hero-icon mt-0.5 shadow-md shadow-neutral-900/5 ring-1 ring-zinc-100/90">
            <IconTicket className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="page-title">{t('nav.requests')}</h1>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-neutral-600">
              {t('pages.requestsSubtitle')}
            </p>
          </div>
        </div>
      </div>

      <div>
        <section className="min-w-0">
          {/* Создание */}
          {tab === 'create' ? (
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 py-2 sm:flex-row sm:items-start sm:gap-6 sm:py-4">
              {!summaryLoading && summary ? (
                <aside className="flex w-full shrink-0 flex-row gap-2 sm:w-44 sm:flex-col sm:gap-2.5 lg:w-48">
                  <MiniStatCard
                    label={t('requests.create.total')}
                    value={summary.service_requests_total}
                    variant="neutral"
                    icon={<IconTicket className="h-4 w-4" />}
                    compact
                  />
                  <MiniStatCard
                    label={t('requests.create.active')}
                    value={summary.service_requests_active}
                    sub={t('requests.create.activeSub')}
                    variant="danger"
                    icon={<IconTicket className="h-4 w-4" />}
                    compact
                  />
                </aside>
              ) : null}

              <form
                onSubmit={onSubmitRequest}
                className="min-w-0 w-full flex-1 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm ring-1 ring-[var(--color-border)] sm:max-w-2xl"
              >
                <div className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-center">
                  <h2 className="font-[family-name:var(--font-display)] text-[13px] font-semibold tracking-tight text-[var(--color-fg)]">
                    {editingRequestId != null
                      ? t('requests.create.editTitle', { id: editingRequestId })
                      : t('requests.create.newTitle')}
                  </h2>
                  <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
                    {editingRequestId != null
                      ? t('requests.create.editSubtitle')
                      : t('requests.create.newSubtitle')}
                  </p>
                </div>

                <div className="space-y-2.5 p-4 sm:p-5">
              {editingRequestId == null ? (
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {t('requests.create.template')}
                </span>
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                  <select
                    value={createTemplateSelect}
                    disabled={tplLoading && tplRows.length === 0}
                    onChange={(e) => {
                      const v = e.target.value
                      setCreateTemplateSelect(v)
                      if (!v) return
                      const tpl = tplRows.find((r) => String(r.id) === v)
                      if (tpl) applyTemplateToForm(tpl)
                      setCreateTemplateSelect('')
                    }}
                    className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] font-medium text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60"
                  >
                    <option value="">{t('requests.create.chooseTemplate')}</option>
                    {tplRows.map((tpl) => (
                      <option key={tpl.id} value={String(tpl.id)}>
                        {tpl.title}
                      </option>
                    ))}
                  </select>
                  {tplLoading ? (
                    <span className="text-xs text-slate-500">{t('requests.create.loadingTemplates')}</span>
                  ) : tplRows.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => navigate('/requests/templates')}
                      className="whitespace-nowrap text-left text-xs font-semibold text-blue-700 hover:underline"
                    >
                      {t('requests.create.noTemplates')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigate('/requests/templates')}
                      className="whitespace-nowrap text-left text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline"
                    >
                      {t('requests.create.manageTemplates')}
                    </button>
                  )}
                </div>
              </label>
              ) : null}

              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  {t('requests.create.title')}
                </span>
                {recentTitles.length > 0 ? (
                  <div className="mb-2 flex flex-wrap gap-2">
                    {recentTitles.map((rt) => (
                      <span
                        key={rt}
                        className="inline-flex max-w-full items-center gap-0.5 rounded-full border border-slate-200/90 bg-slate-50/90 pl-2.5 shadow-sm ring-1 ring-slate-200/40"
                      >
                        <button
                          type="button"
                          className="max-w-[min(14rem,85vw)] truncate py-1 text-left text-xs font-medium text-slate-700 transition hover:text-neutral-800"
                          onClick={() => setTitle(rt)}
                          title={rt}
                        >
                          {rt}
                        </button>
                        <button
                          type="button"
                          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-200/90 hover:text-slate-700"
                          aria-label={t('requests.create.removeRecent', { title: rt })}
                          onClick={() => {
                            removeRecentTitle(rt)
                            setRecentTitles(readRecentTitles())
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                <input
                  placeholder={t('requests.create.titlePlaceholder')}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  className={CREATE_FORM_INPUT_CLS}
                />
              </label>

              <label className="block">
                <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.location')}</span>
                <input
                  value={requestLocation}
                  onChange={(e) => setRequestLocation(e.target.value)}
                  className={CREATE_FORM_INPUT_CLS}
                  placeholder={t('requests.create.locationPlaceholder')}
                />
              </label>

              {!showDescription ? (
                <button
                  type="button"
                  className="text-xs font-medium text-blue-700 hover:text-neutral-800 hover:underline"
                  onClick={() => setShowDescription(true)}
                >
                  {t('requests.create.addDescription')}
                </button>
              ) : (
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.description')}</span>
                  <textarea
                    placeholder={t('requests.create.optional')}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    rows={2}
                    className={`${CREATE_FORM_INPUT_CLS} resize-y`}
                  />
                </label>
              )}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <DirectoryRequesterPicker
                  users={userDir}
                  value={requesterName}
                  onChange={setRequesterName}
                  label={t('requests.create.requester')}
                  placeholder={t('requests.create.pickFromList')}
                  hint={null}
                  labelClassName={CREATE_FORM_LABEL_CLS}
                  inputClassName={CREATE_FORM_INPUT_CLS}
                />
                <CategoryPicker value={category} onChange={setCategory} tree={categoryTree} label={t('requests.categoryPicker.label')} />
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.status')}</span>
                  <select
                    value={createStatus}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isRequestStatus(next)) setCreateStatus(next)
                    }}
                    className={CREATE_FORM_INPUT_CLS}
                  >
                    {REQUEST_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {requestStatusLabel(status)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.priority')}</span>
                  <select
                    value={priority}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isRequestPriority(next)) setPriority(next)
                    }}
                    className={`${CREATE_FORM_INPUT_CLS} font-semibold`}
                  >
                    {REQUEST_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {requestPriorityLabel(p)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.openedAt')}</span>
                  <input
                    type="datetime-local"
                    value={openedAtLocal}
                    onChange={(e) => setOpenedAtLocal(e.target.value)}
                    className={CREATE_FORM_INPUT_CLS}
                  />
                </label>
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.plannedCloseAt')}</span>
                  <input
                    type="datetime-local"
                    value={plannedCloseLocal}
                    onChange={(e) => setPlannedCloseLocal(e.target.value)}
                    className={CREATE_FORM_INPUT_CLS}
                  />
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {DURATION_PRESETS_MIN.map((p) => (
                      <button
                        key={`plan-${p.minutes}`}
                        type="button"
                        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                        title={t('requests.durations.fromOpenedTitle', {
                          label: durationPresetLabel(p.minutes),
                        })}
                        onClick={() => {
                          const v = addMinutesToLocalDatetimeValue(openedAtLocal, p.minutes)
                          if (v) setPlannedCloseLocal(v)
                        }}
                      >
                        +{durationPresetLabel(p.minutes)}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-zinc-50"
                      onClick={() => setPlannedCloseLocal('')}
                      title={t('requests.durations.clearPlanned')}
                    >
                      {t('requests.categoryPicker.reset')}
                    </button>
                  </div>
                </label>
              </div>

              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500/30"
                  checked={closedSameAsPlanned}
                  onChange={(e) => {
                    const on = e.target.checked
                    setClosedSameAsPlanned(on)
                    if (on) {
                      setClosedAtLocal(plannedCloseLocal)
                      if (plannedCloseLocal.trim()) {
                        setCreateStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
                      }
                    }
                  }}
                />
                <span className="text-[11px] leading-snug text-slate-700">
                  {t('requests.create.closedSameAsPlanned')}
                </span>
              </label>

              {!closedSameAsPlanned ? (
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.closedAt')}</span>
                  <input
                    type="datetime-local"
                    value={closedAtLocal}
                    onChange={(e) => {
                      const v = e.target.value
                      setClosedAtLocal(v)
                      if (v.trim()) setCreateStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
                    }}
                    className={CREATE_FORM_INPUT_CLS}
                  />
                  <div className="mt-1 flex flex-wrap gap-0.5">
                    {DURATION_PRESETS_MIN.map((p) => (
                      <button
                        key={`close-${p.minutes}`}
                        type="button"
                        className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-slate-50"
                        title={t('requests.durations.fromOpenedTitle', {
                          label: durationPresetLabel(p.minutes),
                        })}
                        onClick={() => {
                          const v = addMinutesToLocalDatetimeValue(openedAtLocal, p.minutes)
                          setClosedAtLocal(v)
                          if (v.trim()) setCreateStatus('done')
                        }}
                      >
                        +{durationPresetLabel(p.minutes)}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-zinc-50"
                      title={t('requests.durations.clearClosed')}
                      onClick={() => setClosedAtLocal('')}
                    >
                      {t('requests.categoryPicker.reset')}
                    </button>
                  </div>
                </label>
              ) : null}

              {createFormAssignees.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {createFormAssignees.map((u) => (
                    <span
                      key={u.id}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-800 ring-1 ring-slate-200/80"
                    >
                      <span className="truncate">{userDirectoryLabel(u)}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-full px-0.5 leading-none text-slate-500 hover:bg-slate-200 hover:text-slate-900"
                        onClick={() =>
                          setAssigneeIds((ids) => ids.filter((id) => id !== u.id))
                        }
                        aria-label={t('requests.assigneesPicker.remove', { name: userDirectoryLabel(u) })}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 sm:items-end">
                <DirectoryAssigneesPicker
                  users={userDir}
                  selectedIds={assigneeIds}
                  onChange={setAssigneeIds}
                  className="mb-0 min-w-0"
                  labelClassName={CREATE_FORM_LABEL_CLS}
                  inputClassName={CREATE_FORM_INPUT_CLS}
                  hint={null}
                  showSelectedChips={false}
                />
                <ComputerPicker
                  computers={pcList}
                  valueId={computerId}
                  onChange={setComputerId}
                  className="relative mb-0 min-w-0"
                  labelClassName={CREATE_FORM_LABEL_CLS}
                  inputClassName={CREATE_FORM_INPUT_CLS}
                />
              </div>

              <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 px-3 py-3">
                <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.warehouseAction')}</span>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  {t('requests.create.warehouseActionHint')}{' '}
                  <a href="/knowledge-base/warehouse" className="font-medium text-blue-700 underline decoration-blue-200">
                    {t('requests.create.warehouseLink')}
                  </a>
                  .
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="submit"
                  disabled={saving || editDeleting}
                  className="app-btn app-btn-primary w-full !min-h-[40px] !text-[13px]"
                >
                  {saving
                    ? editingRequestId != null
                      ? t('requests.create.saving')
                      : t('requests.create.creating')
                    : editingRequestId != null
                      ? t('requests.create.saveChanges')
                      : t('requests.create.createRequest')}
                </button>

                {editingRequestId != null ? (
                  <>
                    <button
                      type="button"
                      disabled={saving || editDeleting}
                      onClick={cancelEditing}
                      className="w-full rounded-md border border-slate-200 bg-white py-2 text-[13px] font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      {t('requests.create.cancel')}
                    </button>
                    {canManageRequests ? (
                      editDeleteConfirm ? (
                        <div className="rounded-xl border border-red-200 bg-blue-50/90 p-3">
                          <p className="text-sm font-medium text-red-950">
                            {t('requests.create.deleteConfirm', { title })}
                          </p>
                          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                            <button
                              type="button"
                              disabled={editDeleting}
                              onClick={() => void removeEditingRequest()}
                              className="app-btn app-btn-danger flex-1 !min-h-10"
                            >
                              {editDeleting ? t('requests.create.deleting') : t('requests.create.deleteYes')}
                            </button>
                            <button
                              type="button"
                              disabled={editDeleting}
                              onClick={() => setEditDeleteConfirm(false)}
                              className="app-btn app-btn-secondary flex-1 !min-h-10"
                            >
                              {t('requests.create.cancel')}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={saving || editDeleting}
                          onClick={() => {
                            setEditDeleteConfirm(true)
                          }}
                          className="w-full rounded-md border border-blue-200 bg-blue-50 py-2 text-[13px] font-semibold text-blue-800 transition hover:bg-blue-100 disabled:opacity-50"
                        >
                          {t('requests.create.deleteRequest')}
                        </button>
                      )
                    ) : null}
                  </>
                ) : null}
              </div>
                </div>
              </form>
            </div>
        ) : null}

        {/* База */}
        {tab === 'database' ? (
        <div className="min-w-0 lg:col-span-12">

          <div className="mb-2 flex flex-wrap items-center gap-2">
            {filterTabs.map((tab) => {
              const active = filterStatus === tab.id
              return (
                <button
                  key={tab.id ?? 'all'}
                  type="button"
                  onClick={() => setFilterStatus(tab.id)}
                  className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${
                    active
                      ? 'bg-slate-900 text-white'
                      : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setDbShowAll((v) => !v)}
              className="rounded-full bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 transition hover:bg-slate-50 hover:text-slate-900"
              title={dbShowAll ? t('requests.database.showLatest200Title') : t('requests.database.showAllTitle')}
            >
              {dbShowAll ? t('requests.database.showLatest200') : t('requests.database.showAll')}
            </button>
          </div>

          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="sm:max-w-[34rem] sm:flex-1">
              <label className="sr-only" htmlFor="requests-search">
                {t('requests.database.searchLabel')}
              </label>
              <input
                id="requests-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('requests.database.searchPlaceholder')}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400"
              />
              <div className="mt-1 text-[11px] font-medium text-slate-500">
                {t('requests.database.searchHint')}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:min-w-[22rem]">
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm"
                aria-label={t('requests.database.categoryFilterAria')}
                title={t('requests.database.categoryFilterTitle')}
              >
                <option value="">{t('requests.database.categoryAll')}</option>
                {categoryPaths.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm"
                  aria-label={t('requests.database.sortAria')}
                >
                  <option value="id_desc">{t('requests.database.sort.idDesc')}</option>
                  <option value="id_asc">{t('requests.database.sort.idAsc')}</option>
                  <option value="opened_desc">{t('requests.database.sort.openedDesc')}</option>
                  <option value="closed_desc">{t('requests.database.sort.closedDesc')}</option>
                  <option value="priority_desc">{t('requests.database.sort.priorityDesc')}</option>
                </select>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => void downloadPdf()}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-neutral-900 shadow-sm transition hover:bg-neutral-50 disabled:opacity-50"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-600" aria-hidden />
                  {pdfBusy ? 'PDF…' : 'PDF'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setReportOpen(true)}
                className="rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-neutral-800 shadow-sm transition hover:bg-neutral-50"
                title={t('requests.database.reportTitle')}
              >
                {t('requests.database.reportButton')}
              </button>
            </div>
          </div>

          <h2 className="mb-3 text-sm font-semibold text-slate-800">
            {t('requests.database.list')}
            {!loading ? (
              <span className="ml-2 font-normal text-slate-500">· {visibleRows.length}{visibleRows.length !== total ? ` из ${total}` : ''}</span>
            ) : null}
          </h2>

          <div>
            {reportOpen ? (
              <div
                className="fixed inset-0 z-[90] flex items-end justify-center bg-neutral-950/35 p-3 backdrop-blur-[2px] sm:items-center"
                role="dialog"
                aria-modal="true"
                aria-label={t('requests.database.reportModalAria')}
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setReportOpen(false)
                }}
              >
                <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 bg-slate-50/70 px-4 py-3">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">{t('requests.database.reportHeader')}</div>
                      <div className="text-sm font-semibold text-slate-900">
                        {t('requests.database.reportForCurrentList', {
                          visible: visibleRows.length,
                          suffix: visibleRows.length !== total ? ` / ${total}` : '',
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => window.print()}
                        title={t('requests.database.printPdfTitle')}
                      >
                        {t('requests.database.printPdf')}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-neutral-900"
                        onClick={() => setReportOpen(false)}
                      >
                        {t('common.close')}
                      </button>
                    </div>
                  </div>

                  <div className="p-4 sm:p-5">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{t('requests.database.total')}</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-slate-900">
                          {visibleRows.length}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{t('requests.database.totalSub')}</div>
                      </div>
                      <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{t('requests.database.closed')}</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-slate-900">
                          {visibleRows.filter((r) => r.status === 'done').length}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{t('requests.database.closedSub')}</div>
                      </div>
                      <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{t('requests.database.withDeadline')}</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-slate-900">
                          {visibleRows.filter((r) => Boolean(r.planned_close_at)).length}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">{t('requests.database.withDeadlineSub')}</div>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{t('requests.database.byStatus')}</div>
                        <div className="space-y-2">
                          {(() => {
                            const m = new Map<string, number>()
                            for (const r of visibleRows) m.set(r.status, (m.get(r.status) ?? 0) + 1)
                            const items = [...m.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v)
                            const max = Math.max(1, ...items.map((x) => x.v))
                            return items.map((x) => {
                              const pct = Math.round((x.v / Math.max(1, visibleRows.length)) * 100)
                              return (
                                <div key={x.k}>
                                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                                    <span className="font-medium text-slate-700">{requestStatusLabel(x.k)}</span>
                                    <span className="font-mono text-xs font-semibold text-slate-800">
                                      {x.v} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-2 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
                                    <div
                                      className="h-full rounded-full bg-gradient-to-r from-neutral-800 to-blue-700"
                                      style={{ width: `${Math.max(3, Math.round((x.v / max) * 100))}%` }}
                                    />
                                  </div>
                                </div>
                              )
                            })
                          })()}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">{t('requests.database.byPriority')}</div>
                        <div className="space-y-2">
                          {(() => {
                            const m = new Map<string, number>()
                            for (const r of visibleRows) m.set(r.priority, (m.get(r.priority) ?? 0) + 1)
                            const items = [...m.entries()].map(([k, v]) => ({ k, v })).sort((a, b) => b.v - a.v)
                            const max = Math.max(1, ...items.map((x) => x.v))
                            return items.map((x) => {
                              const pct = Math.round((x.v / Math.max(1, visibleRows.length)) * 100)
                              return (
                                <div key={x.k}>
                                  <div className="mb-1 flex items-center justify-between gap-2 text-sm">
                                    <span className="font-medium text-slate-700">{requestPriorityLabel(x.k)}</span>
                                    <span className="font-mono text-xs font-semibold text-slate-800">
                                      {x.v} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-2 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
                                    <div
                                      className="h-full rounded-full bg-gradient-to-r from-slate-700 to-neutral-900"
                                      style={{ width: `${Math.max(3, Math.round((x.v / max) * 100))}%` }}
                                    />
                                  </div>
                                </div>
                              )
                            })
                          })()}
                        </div>
                      </div>
                    </div>

                    <p className="mt-3 text-xs text-slate-500">
                      {t('requests.database.browserPrintNote')}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {loading ? (
              <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-14 text-center text-sm text-slate-500">
                {t('requests.database.loading')}
              </p>
            ) : visibleRows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-14 text-center text-sm text-slate-500">
                {query.trim()
                  ? t('requests.database.noSearchResults')
                  : filterStatus
                    ? t('requests.database.noItemsInFilter')
                    : t('requests.database.empty')}
              </p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white/95 shadow-sm ring-1 ring-slate-200/25">
                <div className="overflow-x-auto">
                  <table className="min-w-[980px] w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-50">
                      <tr className="border-b border-slate-200/70 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                        <th
                          className="cursor-pointer px-3 py-2.5"
                          onClick={() => setSortKey((prev) => (prev === 'id_asc' ? 'id_desc' : 'id_asc'))}
                          title={t('requests.database.table.sortById')}
                        >
                          ID{sortHint('id_asc', 'id_desc')}
                        </th>
                        <th className="px-3 py-2.5">{t('requests.database.table.title')}</th>
                        <th className="px-3 py-2.5">{t('requests.database.table.requester')}</th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('opened_desc')} title={t('requests.database.table.sortByOpened')}>
                          {t('requests.database.table.openedAt')}{sortHint('opened_desc')}
                        </th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('closed_desc')} title={t('requests.database.table.sortByClosed')}>
                          {t('requests.database.table.closedAt')}{sortHint('closed_desc')}
                        </th>
                        <th className="px-3 py-2.5">{t('requests.database.table.status')}</th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('priority_desc')} title={t('requests.database.table.sortByPriority')}>
                          {t('requests.database.table.priority')}{sortHint('priority_desc')}
                        </th>
                        <th className="px-3 py-2.5">{t('requests.database.table.category')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dbRowsToRender.map((row) => (
                        <tr
                          key={row.id}
                          data-request-id={row.id}
                          className="border-b border-slate-100/80 bg-white align-top transition hover:bg-zinc-50/60"
                          onClick={() => openRequestForEdit(row)}
                          role="button"
                          title={t('requests.database.table.editTitle')}
                        >
                              <td className="whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold text-slate-700">
                                <button
                                  type="button"
                                  className="rounded-md px-1.5 py-1 text-left hover:bg-slate-100"
                                  title={t('requests.database.table.findById')}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const q = row.id
                                    setQuery(String(q))
                                  }}
                                >
                                  {requestDisplayNo(row)}
                                </button>
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex min-w-0 items-start gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold text-slate-900" title={row.title}>
                                      <span className="mr-2">{row.title}</span>
                                      {row.external_source === 'bitrix24' ? (
                                        <span
                                          className="inline-flex translate-y-[-1px] items-center rounded-md bg-neutral-950 px-1.5 py-0.5 text-[10px] font-bold tracking-[0.12em] text-white"
                                          title={row.external_id ? `Bitrix24: ${row.external_id}` : 'Bitrix24'}
                                        >
                                          B24
                                        </span>
                                      ) : null}
                                    </div>
                                    {row.computer_hostname ? (
                                      <div className="mt-0.5 truncate text-xs text-slate-500" title={row.computer_hostname}>
                                        {t('requests.database.table.pc', { name: row.computer_hostname })}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{row.requester_name || '—'}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">{fmtRuShortDateTime(row.opened_at ?? row.created_at, locale)}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {fmtRuShortDateTime(row.closed_at ?? row.planned_close_at, locale)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs">
                                <span
                                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                    STATUS_PILL[row.status] ?? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                                  }`}
                                >
                                  {requestStatusLabel(row.status)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-700">
                                {requestPriorityLabel(row.priority)}
                              </td>
                              <td className="px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{row.category || '—'}</span>
                              </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {!loading && visibleRows.length > DB_PAGE_SIZE ? (
              <div className="mt-3 flex items-center justify-between gap-3 text-sm text-slate-600">
                <span>
                  {t('requests.database.pagination.shown', {
                    shown: dbRowsToRender.length,
                    total: visibleRows.length,
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                    onClick={() => setDbPage((p) => Math.max(1, p - 1))}
                    disabled={dbPage <= 1}
                  >
                    {t('requests.database.pagination.back')}
                  </button>
                  <span className="text-xs font-medium">
                    {t('requests.database.pagination.page', {
                      current: Math.min(dbPage, dbPageCount),
                      total: dbPageCount,
                    })}
                  </span>
                  <button
                    type="button"
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                    onClick={() => setDbPage((p) => Math.min(dbPageCount, p + 1))}
                    disabled={dbPage >= dbPageCount}
                  >
                    {t('requests.database.pagination.next')}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        ) : null}

        {/* Статистика */}
        {tab === 'stats' ? (
          <div className="stats-report min-w-0 lg:col-span-12">
            <div className="app-card mb-4 p-5 sm:p-6 print:mb-3 print:rounded-xl print:border print:border-slate-300 print:bg-white print:p-4 print:shadow-none">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border)] pb-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-subtle)]">{t('requests.stats.analytics')}</div>
                  <h2 className="mt-1 font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight text-[var(--color-fg)]">
                    {t('requests.stats.title')}
                  </h2>
                  <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                    {t('requests.stats.loadedHint', { count: rows.length })}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-subtle)] print:text-[11px]">
                    {t('requests.stats.periodGenerated', {
                      period: statsPeriodLabel,
                      date: new Date().toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU'),
                    })}
                  </p>
                </div>
                <div className="stats-report-actions flex flex-wrap gap-2 print:hidden">
                  <button
                    type="button"
                    onClick={() => void downloadExecutivePdf()}
                    className="app-btn app-btn-primary !min-h-[36px] !px-3.5 !py-2 !text-xs"
                    title={t('requests.stats.presentationPdfTitle')}
                  >
                    {t('requests.stats.presentationPdf')}
                  </button>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="app-btn app-btn-secondary !min-h-[36px] !px-3.5 !py-2 !text-xs"
                    title={t('requests.stats.printTitle')}
                  >
                    {t('requests.database.printPdf')}
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadPdf()}
                    className="app-btn app-btn-secondary !min-h-[36px] !px-3.5 !py-2 !text-xs"
                    title={t('requests.stats.tablePdfTitle')}
                  >
                    {t('requests.stats.tablePdf')}
                  </button>
                </div>
              </div>

              <details className="mb-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] print:hidden">
                <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-semibold text-[var(--color-fg)]">
                  {t('requests.stats.pdfOptions')}
                </summary>
                <div className="grid gap-3 border-t border-[var(--color-border)] p-3 lg:grid-cols-12">
                  <label className="block lg:col-span-4">
                    <span className="app-label">{t('requests.stats.reportName')}</span>
                    <input type="text" value={execReportTitle} onChange={(e) => setExecReportTitle(e.target.value)} className="app-input" />
                  </label>
                  <label className="block lg:col-span-4">
                    <span className="app-label">{t('requests.stats.audience')}</span>
                    <input type="text" value={execReportAudience} onChange={(e) => setExecReportAudience(e.target.value)} className="app-input" />
                  </label>
                  <label className="block lg:col-span-4">
                    <span className="app-label">{t('requests.stats.author')}</span>
                    <input
                      type="text"
                      value={execReportAuthor}
                      onChange={(e) => setExecReportAuthor(e.target.value)}
                      placeholder={user?.full_name || user?.username || t('requests.stats.authorPlaceholder')}
                      className="app-input"
                    />
                  </label>
                  <div className="flex flex-wrap items-center gap-2 lg:col-span-12">
                    <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-fg)]">
                      <input type="checkbox" checked={execIncludeNarrative} onChange={(e) => setExecIncludeNarrative(e.target.checked)} />
                      {t('requests.stats.includeNarrative')}
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-fg)]">
                      <input type="checkbox" checked={execIncludeChart} onChange={(e) => setExecIncludeChart(e.target.checked)} />
                      {t('requests.stats.includeChart')}
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-fg)]">
                      <input type="checkbox" checked={execIncludeDistributions} onChange={(e) => setExecIncludeDistributions(e.target.checked)} />
                      {t('requests.stats.includeDistributions')}
                    </label>
                    <label className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs text-[var(--color-fg)]">
                      <input type="checkbox" checked={execIncludeAssigneeLoad} onChange={(e) => setExecIncludeAssigneeLoad(e.target.checked)} />
                      {t('requests.stats.includeAssigneeLoad')}
                    </label>
                  </div>
                </div>
              </details>

              <div className="stats-report-controls grid gap-3 sm:grid-cols-2 lg:grid-cols-12 print:hidden">
                <label className="block lg:col-span-2">
                  <span className="app-label">{t('requests.stats.from')}</span>
                  <input
                    type="date"
                    value={statsFrom}
                    onChange={(e) => setStatsFrom(e.target.value)}
                    className="app-input"
                  />
                </label>
                <label className="block lg:col-span-2">
                  <span className="app-label">{t('requests.stats.to')}</span>
                  <input
                    type="date"
                    value={statsTo}
                    onChange={(e) => setStatsTo(e.target.value)}
                    className="app-input"
                  />
                </label>
                <label className="block lg:col-span-3">
                  <span className="app-label">{t('requests.stats.basis')}</span>
                  <select
                    value={statsBasis}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isStatsBasis(next)) setStatsBasis(next)
                    }}
                    className="app-input"
                  >
                    <option value="opened">{t('requests.stats.basisOpened')}</option>
                    <option value="last_change">{t('requests.stats.basisLastChange')}</option>
                    <option value="closed">{t('requests.stats.basisClosed')}</option>
                  </select>
                </label>
                <label className="block lg:col-span-2">
                  <span className="app-label">{t('requests.stats.grouping')}</span>
                  <select
                    value={statsGroup}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isStatsGroup(next)) setStatsGroup(next)
                    }}
                    className="app-input"
                  >
                    <option value="day">{t('requests.stats.groupDay')}</option>
                    <option value="week">{t('requests.stats.groupWeek')}</option>
                  </select>
                </label>
                <label className="block lg:col-span-2">
                  <span className="app-label">{t('requests.stats.chart')}</span>
                  <select
                    value={statsChartMode}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isStatsChartMode(next)) setStatsChartMode(next)
                    }}
                    className="app-input"
                  >
                    <option value="total">{t('requests.stats.chartTotal')}</option>
                    <option value="status">{t('requests.stats.chartStatus')}</option>
                  </select>
                </label>
                <label className="block lg:col-span-1">
                  <span className="app-label">{t('requests.stats.topN')}</span>
                  <select
                    value={String(statsTopN)}
                    onChange={(e) => setStatsTopN(Math.max(5, Math.min(15, Number(e.target.value) || 8)))}
                    className="app-input"
                  >
                    <option value="6">6</option>
                    <option value="8">8</option>
                    <option value="10">10</option>
                    <option value="12">12</option>
                  </select>
                </label>
                <label className="block lg:col-span-2">
                  <span className="app-label">{t('requests.stats.tableSort')}</span>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="app-input"
                  >
                    <option value="id_desc">{t('requests.stats.sortIdDesc')}</option>
                    <option value="id_asc">{t('requests.stats.sortIdAsc')}</option>
                    <option value="opened_desc">{t('requests.stats.sortOpenedDesc')}</option>
                    <option value="closed_desc">{t('requests.stats.sortClosedDesc')}</option>
                    <option value="priority_desc">{t('requests.stats.sortPriorityDesc')}</option>
                  </select>
                </label>
                <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
                  <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="rounded border-[var(--color-border)]"
                      checked={statsOnlyWithPlanned}
                      onChange={(e) => setStatsOnlyWithPlanned(e.target.checked)}
                    />
                    <span className="text-sm font-medium text-[var(--color-fg)]">{t('requests.stats.onlyWithDeadline')}</span>
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      className="rounded border-[var(--color-border)]"
                      checked={statsOnlyOverdue}
                      onChange={(e) => setStatsOnlyOverdue(e.target.checked)}
                    />
                    <span className="text-sm font-medium text-[var(--color-fg)]">{t('requests.stats.overdueOnly')}</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="stats-report-grid grid gap-4 lg:grid-cols-12 print:gap-3">
              <div className="lg:col-span-4">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3">
                    <span className="h-8 w-1 rounded-full bg-blue-600/90" aria-hidden />
                    <h3 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                      {t('requests.stats.periodKpi')}
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <MiniStatCard label={t('requests.stats.inPeriod')} value={statsRows.length} variant="neutral" icon={<IconTicket className="h-5 w-5" />} />
                    <MiniStatCard
                      label={t('requests.stats.done')}
                      value={statsKpi.done}
                      sub={`${statsKpi.completionRate}% от всех`}
                      variant="neutral"
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                    <MiniStatCard
                      label={t('requests.stats.overdue')}
                      value={statsKpi.overdue}
                      sub={`${statsKpi.overdueRate}% от всех`}
                      variant="neutral"
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                    <MiniStatCard
                      label={t('requests.stats.avgClose')}
                      value={statsKpi.avgCloseHours != null ? `${statsKpi.avgCloseHours} ч` : '—'}
                      sub={t('requests.stats.avgCloseSub')}
                      variant="neutral"
                      compact
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                    <MiniStatCard
                      label={t('requests.stats.slaHit')}
                      value={`${statsKpi.slaHitRate}%`}
                      sub={t('requests.stats.slaHitSub')}
                      variant="neutral"
                      compact
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                  </div>
                </div>
              </div>

              <div className="lg:col-span-8">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3">
                    <span className="h-8 w-1 rounded-full bg-zinc-500/80" aria-hidden />
                    <h3 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                      {t('requests.stats.dynamics')}
                    </h3>
                  </div>

                  {statsSeries.items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-12 text-center text-sm text-slate-500">
                      {t('requests.stats.noDataForPeriod')}
                    </p>
                  ) : (
                    <div className="space-y-3">
                      <div className="h-[280px] rounded-xl border border-slate-200/70 bg-white p-3 shadow-sm print:h-[260px] print:rounded-md print:border-slate-300 print:p-2 print:shadow-none">
                        <Line data={statsLineChart.data} options={statsLineChart.options} />
                      </div>
                      <p className="text-xs text-slate-500">
                        Основание:{' '}
                        <span className="font-medium">
                          {statsBasis === 'opened'
                            ? t('requests.stats.basisOpenedLower')
                            : statsBasis === 'closed'
                              ? t('requests.stats.basisClosedLower')
                              : t('requests.stats.basisLastChangeLower')}
                        </span>
                        , группировка: <span className="font-medium">{statsGroup === 'day' ? t('requests.stats.groupDays') : t('requests.stats.groupWeeks')}</span>.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">{t('requests.stats.byCategoryTop')}</div>
                  <DonutDistribution
                    items={topNWithOther(
                      statsCategoryItems,
                      statsTopN,
                      t('requests.statsData.otherCategories'),
                    )}
                    emptyText={t('requests.stats.noCategories')}
                    compact
                  />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">{t('requests.stats.byRequesterTop')}</div>
                  <DonutDistribution
                    items={topNWithOther(
                      statsRequesterItems,
                      statsTopN,
                      t('requests.statsData.otherUsers'),
                    )}
                    emptyText={t('requests.stats.noRequesters')}
                    compact
                  />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <HorizontalBars
                    title={t('requests.stats.byStatuses')}
                    items={topNWithOther(statsStatusItems, 6, t('requests.statsData.otherStatuses'))}
                    total={statsRows.length}
                  />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <HorizontalBars
                    title={t('requests.stats.byPriorities')}
                    items={topNWithOther(statsPriorityItems, 6, t('requests.statsData.otherPriorities'))}
                    total={statsRows.length}
                  />
                </div>
              </div>

              <div className="lg:col-span-12">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <HorizontalBars
                    title={t('requests.stats.assigneeLoadTop')}
                    items={topNWithOther(statsAssigneeItems, statsTopN, t('requests.statsData.otherAssignees'))}
                    total={Math.max(1, statsRows.reduce((acc, r) => acc + (r.assignee_usernames?.length || 1), 0))}
                  />
                </div>
              </div>

              <div className="lg:col-span-12">
                <div className="rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="h-8 w-1 rounded-full bg-blue-600/90" aria-hidden />
                      <h3 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                        {t('requests.stats.requestsForPeriod')}
                      </h3>
                    </div>
                    <span className="text-xs font-medium text-slate-500">
                      {statsRows.length}{' '}
                      {requestPluralLabel(statsRows.length)}
                    </span>
                  </div>

                  {statsRows.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-10 text-center text-sm text-slate-500">
                      {t('requests.stats.noRequestsForPeriod')}
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/70 print:rounded-md print:border-slate-300">
                      <table className="min-w-[880px] w-full border-collapse text-left text-sm print:min-w-0 print:text-xs">
                        <thead className="bg-slate-50/95 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                          <tr className="border-b border-slate-200/70">
                            <th className="px-3 py-2.5">ID</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.title')}</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.status')}</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.requester')}</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.openedAt')}</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.closedAt')}</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.priority')}</th>
                            <th className="px-3 py-2.5">{t('requests.database.table.category')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statsRows.map((row) => (
                            <tr
                              key={row.id}
                              data-request-id={row.id}
                              className="cursor-pointer border-b border-slate-100/80 bg-white align-top transition hover:bg-zinc-50/60"
                              onClick={() => openRequestForEdit(row)}
                              title={t('requests.database.table.editTitle')}
                            >
                              <td className="whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold text-slate-700">
                                {requestDisplayNo(row)}
                              </td>
                              <td className="max-w-[240px] px-3 py-3">
                                <div className="truncate font-semibold text-slate-900" title={row.title}>
                                  {row.title}
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs">
                                <span
                                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                    STATUS_PILL[row.status] ?? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                                  }`}
                                >
                                  {requestStatusLabel(row.status)}
                                </span>
                              </td>
                              <td className="max-w-[140px] px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{row.requester_name || '—'}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {fmtRuShortDateTime(row.opened_at ?? row.created_at, locale)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {fmtRuShortDateTime(row.closed_at ?? row.planned_close_at, locale)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-700">
                                {requestPriorityLabel(row.priority)}
                              </td>
                              <td className="max-w-[180px] px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{row.category || '—'}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Шаблоны */}
        {tab === 'templates' ? (
          <div className="min-w-0 lg:col-span-12">

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <div className="app-card rounded-2xl border-slate-200/70 p-5 sm:p-6">
                  <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3">
                    <span className="h-8 w-1 rounded-full bg-blue-600/90" aria-hidden />
                    <h2 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                      {tplEditingId != null ? t('requests.templates.editTitle') : t('requests.templates.newTitle')}
                    </h2>
                    {tplEditingId != null ? (
                      <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 ring-1 ring-amber-200/80">
                        #{tplEditingId}
                      </span>
                    ) : null}
                  </div>

                  <label className="mb-3 block">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {t('requests.templates.templateTitle')}
                    </span>
                    <input
                      value={tplTitle}
                      onChange={(e) => setTplTitle(e.target.value)}
                      className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400"
                      placeholder={t('requests.templates.templateTitlePlaceholder')}
                    />
                  </label>

                  <label className="mb-3 block">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {t('requests.templates.description')}
                    </span>
                    <textarea
                      value={tplDescription}
                      onChange={(e) => setTplDescription(e.target.value)}
                      rows={3}
                      className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400"
                    />
                  </label>

                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <DirectoryRequesterPicker
                      users={userDir}
                      value={tplRequesterName}
                      onChange={setTplRequesterName}
                      label={t('requests.templates.requesterDefault')}
                      placeholder={t('requests.templates.requesterPlaceholder')}
                      hint={t('requests.templates.requesterHint')}
                    />
                    <CategoryPicker
                      value={tplCategory}
                      onChange={setTplCategory}
                      tree={categoryTree}
                      label={t('requests.templates.categoryDefault')}
                    />
                  </div>

                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {t('requests.templates.statusDefault')}
                      </span>
                      <select
                        value={tplStatus}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestStatus(next)) setTplStatus(next)
                        }}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                      >
                        {REQUEST_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {requestStatusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {t('requests.templates.priorityDefault')}
                      </span>
                      <select
                        value={tplPriority}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestPriority(next)) setTplPriority(next)
                        }}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                      >
                        {REQUEST_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {requestPriorityLabel(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {t('requests.templates.openedAt')}
                      </span>
                      <input
                        type="datetime-local"
                        value={tplOpenedAtLocal}
                        onChange={(e) => setTplOpenedAtLocal(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        {t('requests.templates.plannedCloseAt')}
                      </span>
                      <input
                        type="datetime-local"
                        value={tplPlannedCloseLocal}
                        onChange={(e) => setTplPlannedCloseLocal(e.target.value)}
                        className="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900"
                      />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {DURATION_PRESETS_MIN.map((p) => (
                      <button
                        key={`tpl-${p.minutes}`}
                        type="button"
                        className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
                        title={t('requests.durations.fromTemplateOpenedTitle', {
                          label: durationPresetLabel(p.minutes),
                          hotkey: p.hotkey,
                        })}
                        onClick={() => setTplPlannedCloseLocal(addMinutesToLocalDatetimeValue(tplOpenedAtLocal, p.minutes))}
                      >
                        +{durationPresetLabel(p.minutes)}
                      </button>
                    ))}
                  </div>
                    </label>
                  </div>

                  <label className="mb-3 block">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {t('requests.templates.closedAt')}
                    </span>
                    <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500/30"
                        checked={tplClosedSameAsPlanned}
                        onChange={(e) => {
                          const on = e.target.checked
                          setTplClosedSameAsPlanned(on)
                          if (on) {
                            setTplClosedAtLocal(tplPlannedCloseLocal)
                            if (tplPlannedCloseLocal.trim()) {
                              setTplStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
                            }
                          }
                        }}
                      />
                      <span className="text-[11px] leading-snug text-slate-700">
                        {t('requests.templates.closedSameAsPlanned')}
                      </span>
                    </label>
                    {!tplClosedSameAsPlanned ? (
                      <input
                        type="datetime-local"
                        value={tplClosedAtLocal}
                        onChange={(e) => {
                          const v = e.target.value
                          setTplClosedAtLocal(v)
                          if (v.trim()) setTplStatus((prev) => (prev === 'cancelled' ? 'cancelled' : 'done'))
                        }}
                        className="w-full rounded-xl border border-slate-200/90 bg-white px-2 py-2 text-sm text-slate-900 shadow-sm"
                      />
                    ) : null}
                  </label>

                  <DirectoryAssigneesPicker
                    users={userDir}
                    selectedIds={tplAssigneeIds}
                    onChange={setTplAssigneeIds}
                    inputClassName="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-blue-500/15"
                    hint={t('requests.templates.assigneesHint')}
                  />
                  <div className="mb-4">
                    <ComputerPicker computers={pcList} valueId={tplComputerId} onChange={setTplComputerId} />
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    {tplEditingId != null ? (
                      <button
                        type="button"
                        disabled={tplBusy}
                        onClick={() => resetTemplateForm()}
                        className="w-full rounded-xl border border-slate-200 bg-white py-3 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:opacity-50 sm:w-auto sm:min-w-[8rem]"
                      >
                        {t('requests.templates.cancel')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={tplBusy || !tplTitle.trim()}
                      onClick={() => void saveTemplateFromForm()}
                      className="app-btn app-btn-primary w-full flex-1 !min-h-[48px]"
                    >
                      {tplBusy
                        ? t('requests.templates.saving')
                        : tplEditingId != null
                          ? t('requests.templates.saveChanges')
                          : t('requests.templates.saveTemplate')}
                    </button>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-8">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <h2 className="text-sm font-semibold text-[var(--color-fg)]">
                    {t('requests.templates.title')}
                    {!tplLoading ? <span className="ml-2 font-normal text-[var(--color-fg-muted)]">· {tplTotal}</span> : null}
                  </h2>
                  <button
                    type="button"
                    disabled={tplLoading}
                    onClick={() => void loadTemplates()}
                    className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2 !text-xs disabled:opacity-50"
                  >
                    {t('requests.templates.refresh')}
                  </button>
                </div>

                <div className="space-y-3">
                  {tplLoading ? (
                    <p className="app-empty-state">{t('requests.templates.loading')}</p>
                  ) : tplRows.length === 0 ? (
                    <p className="app-empty-state">{t('requests.templates.empty')}</p>
                  ) : (
                    tplRows.map((tpl) => (
                      <article
                        key={tpl.id}
                        className="app-card px-4 py-4"
                      >
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => applyTemplateToForm(tpl)}
                              className="app-btn app-btn-primary !min-h-0 !px-3 !py-1.5 !text-xs"
                            >
                              {t('requests.templates.apply')}
                            </button>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => beginEditTemplate(tpl)}
                                className="app-btn app-btn-secondary !min-h-0 !px-2.5 !py-1.5"
                                title={t('requests.templates.edit')}
                                aria-label={t('requests.templates.edit')}
                              >
                                <IconPencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                disabled={tplBusy}
                                onClick={() => void deleteTemplate(tpl.id, tpl.title)}
                                className="app-btn app-btn-secondary !min-h-0 !px-2.5 !py-1.5 disabled:opacity-50"
                                title={t('requests.templates.delete')}
                                aria-label={t('requests.templates.delete')}
                              >
                                <IconTrash className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-semibold text-[var(--color-fg)]">{tpl.title}</h3>
                              <span
                                className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${STATUS_PILL[tpl.status] ?? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'}`}
                              >
                                {requestStatusLabel(tpl.status)}
                              </span>
                            </div>
                            {tpl.description ? (
                              <p className="mt-2 text-sm leading-relaxed text-[var(--color-fg-muted)]">{tpl.description}</p>
                            ) : null}
                            {tpl.requester_name || tpl.category ? (
                              <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-[var(--color-fg-muted)]">
                                {tpl.requester_name ? (
                                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1">
                                    {t('requests.templates.requester', { name: tpl.requester_name })}
                                  </span>
                                ) : null}
                                {tpl.category ? (
                                  <span className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1">
                                    {t('requests.templates.category', { name: tpl.category })}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-[var(--color-fg-subtle)]">
                              <span>{tpl.created_by_username}</span>
                              {tpl.assignee_usernames && tpl.assignee_usernames.length > 0 ? (
                                <span className="font-medium text-[var(--color-fg-muted)]" title={tpl.assignee_usernames.join(', ')}>
                                  {t('requests.templates.assignees', { names: tpl.assignee_usernames.join(', ') })}
                                </span>
                              ) : null}
                              {tpl.computer_id ? <span>{t('requests.templates.pc', { id: tpl.computer_id })}</span> : null}
                              <span>· {requestPriorityLabel(tpl.priority)}</span>
                            </div>
                            <div className="mt-2 grid grid-cols-1 gap-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-2 text-[11px] text-[var(--color-fg-muted)] sm:grid-cols-3">
                              <span>
                                {t('requests.templates.openedDate', { date: fmtRuDateTime(tpl.opened_at, locale) })}
                              </span>
                              <span>
                                {t('requests.templates.plannedDate', { date: fmtRuDateTime(tpl.planned_close_at, locale) })}
                              </span>
                              <span>
                                {t('requests.templates.closedDate', { date: fmtRuDateTime(tpl.closed_at, locale) })}
                              </span>
                            </div>
                          </div>
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : null}
        </section>
      </div>
    </div>
  )
}
