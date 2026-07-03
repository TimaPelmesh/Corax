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
import { IconTicket } from '../components/icons'
import { collectCategoryPaths, filterCategoryTree, flattenCategoryNodes } from '../requestCategories'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

const STATUS_RU: Record<string, string> = {
  open: 'Открыта',
  in_progress: 'В работе',
  done: 'Закрыта',
  cancelled: 'Отменена',
}

const PRIORITY_RU: Record<string, string> = {
  low: 'Низкий',
  normal: 'Обычный',
  high: 'Высокий',
}

const REQUEST_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const
const REQUEST_PRIORITIES = ['low', 'normal', 'high'] as const

const CREATE_FORM_INPUT_CLS =
  'w-full rounded-md border border-slate-200/90 bg-white px-2 py-1.5 text-[13px] text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-red-500/20'
const CREATE_FORM_LABEL_CLS =
  'mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-slate-500'
const STATS_BASES = ['opened', 'last_change', 'closed'] as const
const STATS_GROUPS = ['day', 'week'] as const
const STATS_CHART_MODES = ['total', 'status'] as const

type RequestStatus = (typeof REQUEST_STATUSES)[number]
type RequestPriority = (typeof REQUEST_PRIORITIES)[number]
type StatsBasis = (typeof STATS_BASES)[number]
type StatsGroup = (typeof STATS_GROUPS)[number]
type StatsChartMode = (typeof STATS_CHART_MODES)[number]

const STATUS_PILL: Record<string, string> = {
  open: 'bg-red-50 text-red-950 ring-1 ring-red-200/90',
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

function fmtRuDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = parseIsoToDate(iso)
    if (!d) return '—'
    return d.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

function fmtRuShortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = parseIsoToDate(iso)
    if (!d) return '—'
    return d.toLocaleString('ru-RU', {
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
  label = 'Категория',
  placeholder = 'Выберите категорию…',
}: {
  value: string
  onChange: (v: string) => void
  tree?: RequestCategoryTreeNode[]
  label?: string
  placeholder?: string
}) {
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
      <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder={placeholder}
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
          className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-red-500/20"
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
            title="Сбросить категорию"
          >
            Сброс
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
              — не указано —
            </button>
          </li>
          {flatFiltered.map(({ node, depth }) => {
            const active = value.trim() === node.path.trim()
            return (
              <li key={node.id}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-1 py-2 text-left text-sm ${
                    active ? 'bg-red-50/70 text-red-950' : 'text-slate-800 hover:bg-zinc-50/80'
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
            <li className="px-3 py-2 text-sm text-slate-400">Ничего не найдено</li>
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
  otherLabel = 'Остальные',
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
const DONUT_COLORS = ['#0a0a0a', '#dc2626', '#404040', '#737373', '#991b1b', '#525252', '#a3a3a3', '#d4d4d4']

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
        {emptyText ?? 'Нет данных'}
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
          aria-label="Круговая диаграмма распределения"
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
            <span className="text-[11px] font-medium text-neutral-500">всего</span>
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
  if (!items.length || total <= 0) {
    return (
      <div className="rounded-xl border border-dashed border-neutral-200/90 bg-neutral-50/60 px-4 py-6 text-center text-sm text-neutral-500">
        Нет данных
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
                <div className="h-full rounded-full bg-gradient-to-r from-red-600 to-zinc-700" style={{ width: `${pct}%` }} />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const DURATION_PRESETS_MIN = [
  { label: '15 мин', minutes: 15, hotkey: 'Alt+1' },
  { label: '30 мин', minutes: 30, hotkey: 'Alt+2' },
  { label: '60 мин', minutes: 60, hotkey: 'Alt+3' },
  { label: '90 мин', minutes: 90, hotkey: 'Alt+4' },
] as const

const FILTER_TABS: { id: string | null; label: string }[] = [
  { id: null, label: 'Все' },
  { id: 'open', label: 'Открытые' },
  { id: 'in_progress', label: 'В работе' },
  { id: 'done', label: 'Закрытые' },
  { id: 'cancelled', label: 'Отменены' },
]

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
    variant === 'danger' ? 'ring-red-200/80' : 'ring-neutral-200/90'
  const iconBg =
    variant === 'danger' ? 'bg-red-50 text-red-950' : 'bg-neutral-100 text-neutral-700'

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

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="fixed bottom-6 left-1/2 z-[100] flex max-w-md -translate-x-1/2 items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-950 px-4 py-3 text-sm font-medium text-white shadow-lg"
    >
      <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" aria-hidden />
      {message}
      <button
        type="button"
        onClick={onDismiss}
        className="ml-2 rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-white"
        aria-label="Закрыть"
      >
        ×
      </button>
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
        ПК (необязательно)
      </label>
      <div className="relative">
        <input
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          placeholder="Поиск по имени хоста…"
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
            Сброс
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
              — не привязано —
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
            <li className="px-3 py-2 text-sm text-slate-400">Ничего не найдено</li>
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
            'w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-red-500/20'
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
                — очистить —
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
              <li className="px-3 py-2 text-sm text-slate-400">Нет совпадений в справочнике</li>
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
  label = 'Ответственные за исполнение',
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
    'w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-red-500/20'

  return (
    <div className={className ?? 'mb-3'}>
      <span
        className={
          labelClassName ?? 'mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500'
        }
      >
        {label}
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
                aria-label={`Убрать ${userDirectoryLabel(u)}`}
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
          placeholder="Начните вводить и выберите из списка"
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
                  — сбросить всех —
                </button>
              </li>
            ) : null}
            {filtered.map((u) => {
              const sel = selectedIds.includes(u.id)
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    className={`w-full px-3 py-2 text-left text-sm hover:bg-zinc-50/80 ${sel ? 'bg-red-50/40 font-semibold text-red-950' : 'text-slate-800'}`}
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
              <li className="px-3 py-2 text-sm text-slate-400">Нет пользователей в справочнике</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-400">Нет совпадений в справочнике</li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {hint != null && hint !== '' ? <p className="mt-1 text-[10px] text-slate-500">{hint}</p> : null}
    </div>
  )
}

export function ServiceRequestsPage() {
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
  const [err, setErr] = useState<string | null>(null)
  const [filterStatus, setFilterStatus] = useState<string | null>(null)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [dbShowAll, setDbShowAll] = useState(false)

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
  const [toast, setToast] = useState<string | null>(null)

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
  const listScrollRestoreRef = useRef<{ path: string; scrollTop: number } | null>(null)
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
  const [execReportTitle, setExecReportTitle] = useState('Отчет по заявкам')
  const [execReportAudience, setExecReportAudience] = useState('Для руководства')
  const [execReportAuthor, setExecReportAuthor] = useState('')
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
        const arr = r.assignee_usernames?.length ? r.assignee_usernames : ['Без исполнителя']
        for (const n of arr) acc.set(n, (acc.get(n) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    [statsRows],
  )

  const statsPriorityItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const p = PRIORITY_RU[r.priority] ?? r.priority
        acc.set(p, (acc.get(p) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()].map(([name, count]) => ({ name, count })),
    [statsRows],
  )

  const statsStatusItems = useMemo(
    () =>
      [...(statsRows.reduce((acc, r) => {
        const s = STATUS_RU[r.status] ?? r.status
        acc.set(s, (acc.get(s) ?? 0) + 1)
        return acc
      }, new Map<string, number>())).entries()].map(([name, count]) => ({ name, count })),
    [statsRows],
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
    const from = statsFrom.trim() || 'начала данных'
    const to = statsTo.trim() || 'сегодня'
    return `${from} - ${to}`
  }, [statsFrom, statsTo])

  const statsLineChart = useMemo(() => {
    const labels = statsSeries.items.map((x) => x.key)
    const data = statsSeries.items.map((x) => x.total)
    const statusDatasetDefs = [
      { key: 'open', label: 'Открыты', color: '#dc2626', bg: 'rgb(220 38 38 / 0.1)' },
      { key: 'in_progress', label: 'В работе', color: '#0f172a', bg: 'rgb(15 23 42 / 0.1)' },
      { key: 'done', label: 'Закрыты', color: '#334155', bg: 'rgb(51 65 85 / 0.1)' },
      { key: 'cancelled', label: 'Отменены', color: '#64748b', bg: 'rgb(100 116 139 / 0.1)' },
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
                  label: 'Заявки',
                  data,
                  borderColor: 'rgb(220 38 38)',
                  backgroundColor: 'rgb(220 38 38 / 0.12)',
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
  }, [statsChartMode, statsSeries.items])

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

  const load = useCallback(async () => {
    setErr(null)
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
      setErr(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setLoading(false)
    }
  }, [dbShowAll, filterStatus, tab])

  const loadTemplates = useCallback(async () => {
    setErr(null)
    setTplLoading(true)
    try {
      const r = await api.serviceRequestTemplates({ limit: 300 })
      setTplRows(r.items)
      setTplTotal(r.total)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
      setTplRows([])
      setTplTotal(0)
    } finally {
      setTplLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSummary()
  }, [refreshSummary])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const saved = listScrollRestoreRef.current
    if (!saved || loading) return
    if (location.pathname !== saved.path) return

    const top = saved.scrollTop
    listScrollRestoreRef.current = null

    const frame = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const el = getAppScrollContainer()
        if (el) el.scrollTop = top
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [location.pathname, loading, visibleRows.length])

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.computers({ limit: 500 })
        setPcList(r.items)
      } catch {
        setPcList([])
      }
    })()
  }, [])

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

  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(t)
  }, [toast])

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

  function openRequestForEdit(t: ServiceRequestRow) {
    const scrollEl = getAppScrollContainer()
    if (scrollEl) {
      listScrollRestoreRef.current = { path: location.pathname, scrollTop: scrollEl.scrollTop }
    }
    populateFormFromRequest(t)
    setEditingRequestId(t.id)
    setEditingReturnPath(location.pathname)
    setEditDeleteConfirm(false)
    setErr(null)
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
    if (returnPath && returnPath !== '/requests') navigate(returnPath)
  }

  async function onSubmitRequest(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    setSaving(true)
    setErr(null)
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
        setToast('Сохранено')
        void refreshSummary()
        if (returnPath && returnPath !== '/requests') navigate(returnPath)
      } else {
        await api.createServiceRequest(body)
        pushRecentTitle(title.trim())
        setRecentTitles(readRecentTitles())
        setTitle('')
        setDescription('')
        resetCreateFormAfterSubmit()
        setToast('Заявка создана')
        await load()
        void refreshSummary()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setSaving(false)
    }
  }

  async function downloadPdf() {
    setErr(null)
    setPdfBusy(true)
    try {
      await api.exportServiceRequestsPdf({ status: filterStatus, limit: dbShowAll ? 2000 : 400 })
      setToast('PDF сохранён')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
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
        setErr('Браузер заблокировал окно печати. Разрешите pop-up и попробуйте снова.')
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
          setErr('Не удалось открыть окно отчета. Разрешите pop-up и повторите.')
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
      setErr(e instanceof Error ? e.message : 'Не удалось сформировать Executive PDF')
    }
  }

  async function removeEditingRequest() {
    if (editingRequestId == null || editDeleting) return
    setErr(null)
    setEditDeleting(true)
    try {
      await api.deleteServiceRequest(editingRequestId)
      const id = editingRequestId
      if (datesEdit?.id === id) setDatesEdit(null)
      const returnPath = editingReturnPath
      setTitle('')
      setDescription('')
      resetCreateFormAfterSubmit()
      setToast('Заявка удалена')
      await load()
      void refreshSummary()
      if (returnPath && returnPath !== '/requests') navigate(returnPath)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка удаления')
    } finally {
      setEditDeleting(false)
    }
  }

  function applyTemplateToForm(t: ServiceRequestTemplateRow) {
    setTitle(t.title)
    setDescription(t.description ?? '')
    setShowDescription(Boolean(t.description))
    setCreateStatus(isRequestStatus(t.status) ? t.status : 'open')
    setPriority(isRequestPriority(t.priority) ? t.priority : 'normal')
    setAssigneeIds(Array.isArray(t.assignee_ids) ? t.assignee_ids : [])
    setComputerId(t.computer_id ? String(t.computer_id) : '')
    setRequesterName((t.requester_name ?? '').trim())
    setCategory((t.category ?? '').trim())
    setOpenedAtLocal(t.opened_at ? toDatetimeLocalValue(t.opened_at) : defaultOpenedLocal())
    const planned = t.planned_close_at ? toDatetimeLocalValue(t.planned_close_at) : defaultPlannedCloseLocal()
    const closed = t.closed_at ? toDatetimeLocalValue(t.closed_at) : ''
    setPlannedCloseLocal(planned)
    setClosedAtLocal(closed)
    setClosedSameAsPlanned(Boolean(closed && planned && closed === planned))
    navigate('/requests')
    setToast(`Шаблон применён: ${t.title}`)
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
    setErr(null)
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
        setToast('Шаблон обновлён')
      } else {
        await api.createServiceRequestTemplate(body)
        setToast('Шаблон сохранён')
      }
      resetTemplateForm()
      await loadTemplates()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setTplBusy(false)
    }
  }

  async function deleteTemplate(id: number, title: string) {
    if (!window.confirm(`Удалить шаблон «${title}»?`)) return
    setTplBusy(true)
    setErr(null)
    try {
      await api.deleteServiceRequestTemplate(id)
      if (tplEditingId === id) resetTemplateForm()
      setToast('Шаблон удалён')
      await loadTemplates()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка')
    } finally {
      setTplBusy(false)
    }
  }

  // startDatesEdit/saveDatesEdit removed (will re-introduce in modal if required)

  return (
    <div>
      {toast ? <Toast message={toast} onDismiss={() => setToast(null)} /> : null}

      <div className="mb-5 overflow-hidden rounded-2xl border border-neutral-200/70 bg-gradient-to-br from-white via-neutral-50 to-red-50/40 px-5 py-4 shadow-sm ring-1 ring-neutral-200/30 sm:px-8 sm:py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-5">
          <div className="page-hero-icon mt-0.5 shadow-md shadow-neutral-900/5 ring-1 ring-zinc-100/90">
            <IconTicket className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="page-title">Заявки</h1>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-neutral-600">
              Создание заявок и работа со списком. Все данные хранятся в базе.
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
                    label="Всего"
                    value={summary.service_requests_total}
                    variant="neutral"
                    icon={<IconTicket className="h-4 w-4" />}
                    compact
                  />
                  <MiniStatCard
                    label="Активных"
                    value={summary.service_requests_active}
                    sub="открыта / в работе"
                    variant="danger"
                    icon={<IconTicket className="h-4 w-4" />}
                    compact
                  />
                </aside>
              ) : null}

              <form
                onSubmit={onSubmitRequest}
                className="min-w-0 w-full flex-1 overflow-hidden rounded-lg border border-slate-200/70 bg-white shadow-sm ring-1 ring-slate-200/40 sm:max-w-2xl"
              >
                <div className="border-b border-slate-100 bg-gradient-to-br from-white via-slate-50 to-red-50/40 px-3 py-2 text-center">
                  <h2 className="font-[family-name:var(--font-display)] text-[13px] font-semibold tracking-tight text-slate-900">
                    {editingRequestId != null ? `Редактирование заявки #${editingRequestId}` : 'Новая заявка'}
                  </h2>
                  <p className="mt-0.5 text-[10px] text-slate-600">
                    {editingRequestId != null
                      ? 'Те же поля и списки, что при создании. После сохранения вернётесь к списку.'
                      : 'Шаблон подставит даты, статус и исполнителей.'}
                  </p>
                </div>

                <div className="space-y-2.5 p-4 sm:p-5">
              {editingRequestId == null ? (
              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Шаблон
                </span>
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
                  <select
                    value={createTemplateSelect}
                    disabled={tplLoading && tplRows.length === 0}
                    onChange={(e) => {
                      const v = e.target.value
                      setCreateTemplateSelect(v)
                      if (!v) return
                      const t = tplRows.find((r) => String(r.id) === v)
                      if (t) applyTemplateToForm(t)
                      setCreateTemplateSelect('')
                    }}
                    className="w-full rounded-md border border-slate-200 bg-white px-2 py-1.5 text-[13px] font-medium text-slate-900 shadow-sm transition focus:border-zinc-500 focus:ring-2 focus:ring-red-500/20 disabled:opacity-60"
                  >
                    <option value="">— Выберите шаблон —</option>
                    {tplRows.map((t) => (
                      <option key={t.id} value={String(t.id)}>
                        {t.title}
                      </option>
                    ))}
                  </select>
                  {tplLoading ? (
                    <span className="text-xs text-slate-500">Загрузка шаблонов…</span>
                  ) : tplRows.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => navigate('/requests/templates')}
                      className="whitespace-nowrap text-left text-xs font-semibold text-red-700 hover:underline"
                    >
                      Нет шаблонов — создать на вкладке «Шаблоны»
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => navigate('/requests/templates')}
                      className="whitespace-nowrap text-left text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline"
                    >
                      Управление шаблонами
                    </button>
                  )}
                </div>
              </label>
              ) : null}

              <label className="block">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                  Заголовок
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
                          aria-label={`Удалить «${rt}» из подсказок`}
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
                  placeholder="Кратко, по сути"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  required
                  className={CREATE_FORM_INPUT_CLS}
                />
              </label>

              <label className="block">
                <span className={CREATE_FORM_LABEL_CLS}>Местоположение</span>
                <input
                  value={requestLocation}
                  onChange={(e) => setRequestLocation(e.target.value)}
                  className={CREATE_FORM_INPUT_CLS}
                  placeholder="OPM"
                />
              </label>

              {!showDescription ? (
                <button
                  type="button"
                  className="text-xs font-medium text-red-700 hover:text-neutral-800 hover:underline"
                  onClick={() => setShowDescription(true)}
                >
                  + Описание
                </button>
              ) : (
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>Описание</span>
                  <textarea
                    placeholder="Необязательно"
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
                  label="Инициатор"
                  placeholder="Выберите из списка"
                  hint={null}
                  labelClassName={CREATE_FORM_LABEL_CLS}
                  inputClassName={CREATE_FORM_INPUT_CLS}
                />
                <CategoryPicker value={category} onChange={setCategory} tree={categoryTree} label="Категория" />
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>Статус</span>
                  <select
                    value={createStatus}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isRequestStatus(next)) setCreateStatus(next)
                    }}
                    className={CREATE_FORM_INPUT_CLS}
                  >
                    {Object.entries(STATUS_RU).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>Приоритет</span>
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
                        {PRIORITY_RU[p]}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>Дата открытия</span>
                  <input
                    type="datetime-local"
                    value={openedAtLocal}
                    onChange={(e) => setOpenedAtLocal(e.target.value)}
                    className={CREATE_FORM_INPUT_CLS}
                  />
                </label>
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>Дата закрытия</span>
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
                        title={`Через ${p.label} от даты открытия (Alt+1…4)`}
                        onClick={() => {
                          const v = addMinutesToLocalDatetimeValue(openedAtLocal, p.minutes)
                          if (v) setPlannedCloseLocal(v)
                        }}
                      >
                        +{p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-zinc-50"
                      onClick={() => setPlannedCloseLocal('')}
                      title="Очистить назначенную дату закрытия"
                    >
                      Очистить
                    </button>
                  </div>
                </label>
              </div>

              <label className="flex cursor-pointer items-center gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500/30"
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
                  Фактическая дата закрытия = дата закрытия
                </span>
              </label>

              {!closedSameAsPlanned ? (
                <label className="block">
                  <span className={CREATE_FORM_LABEL_CLS}>Фактическая дата закрытия</span>
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
                        title={`Через ${p.label} от даты открытия`}
                        onClick={() => {
                          const v = addMinutesToLocalDatetimeValue(openedAtLocal, p.minutes)
                          setClosedAtLocal(v)
                          if (v.trim()) setCreateStatus('done')
                        }}
                      >
                        +{p.label}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 hover:bg-zinc-50"
                      title="Очистить фактическую дату закрытия"
                      onClick={() => setClosedAtLocal('')}
                    >
                      Очистить
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
                        aria-label={`Убрать ${userDirectoryLabel(u)}`}
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
                <span className={CREATE_FORM_LABEL_CLS}>Действие со складом</span>
                <p className="mt-1 text-xs leading-relaxed text-slate-500">
                  Здесь появится выдача и установка комплектующих (ОЗУ, SSD, сетевое и др.) с привязкой к этой
                  заявке. Пока учёт свободного оборудования — в разделе{' '}
                  <a href="/knowledge-base/warehouse" className="font-medium text-red-700 underline decoration-red-200">
                    Склад
                  </a>
                  .
                </p>
              </div>

              {err && editingRequestId != null ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-900">
                  {err}
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                <button
                  type="submit"
                  disabled={saving || editDeleting}
                  className="w-full rounded-md bg-red-600 py-2 text-[13px] font-semibold text-white shadow-md shadow-red-600/20 transition hover:bg-red-700 disabled:opacity-50"
                >
                  {saving
                    ? editingRequestId != null
                      ? 'Сохранение…'
                      : 'Создание…'
                    : editingRequestId != null
                      ? 'Сохранить изменения'
                      : 'Создать заявку'}
                </button>

                {editingRequestId != null ? (
                  <>
                    <button
                      type="button"
                      disabled={saving || editDeleting}
                      onClick={cancelEditing}
                      className="w-full rounded-md border border-slate-200 bg-white py-2 text-[13px] font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
                    >
                      Отмена
                    </button>
                    {canManageRequests ? (
                      editDeleteConfirm ? (
                        <div className="rounded-xl border border-red-200 bg-red-50/90 p-3">
                          <p className="text-sm font-medium text-red-950">
                            Удалить заявку «{title}»? Действие необратимо.
                          </p>
                          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                            <button
                              type="button"
                              disabled={editDeleting}
                              onClick={() => void removeEditingRequest()}
                              className="app-btn app-btn-danger flex-1 !min-h-10"
                            >
                              {editDeleting ? 'Удаление…' : 'Да, удалить'}
                            </button>
                            <button
                              type="button"
                              disabled={editDeleting}
                              onClick={() => setEditDeleteConfirm(false)}
                              className="app-btn app-btn-secondary flex-1 !min-h-10"
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          disabled={saving || editDeleting}
                          onClick={() => {
                            setEditDeleteConfirm(true)
                            setErr(null)
                          }}
                          className="w-full rounded-md border border-red-200 bg-red-50 py-2 text-[13px] font-semibold text-red-800 transition hover:bg-red-100 disabled:opacity-50"
                        >
                          Удалить заявку
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
          {err ? (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900">
              {err}
            </div>
          ) : null}

          <div className="mb-2 flex flex-wrap items-center gap-2">
            {FILTER_TABS.map((tab) => {
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
              title={dbShowAll ? 'Показывать только последние 200' : 'Показать до 1000 заявок'}
            >
              {dbShowAll ? 'Последние 200' : 'Показать все'}
            </button>
          </div>

          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div className="sm:max-w-[34rem] sm:flex-1">
              <label className="sr-only" htmlFor="requests-search">
                Поиск по заявкам
              </label>
              <input
                id="requests-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск слева (можно #ID): заголовок, инициатор, категория, ПК…"
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400"
              />
              <div className="mt-1 text-[11px] font-medium text-slate-500">
                Подсказка: введи <span className="font-mono">#118</span> или <span className="font-mono">118</span> — найдёт по ID/GLPI ID.
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:min-w-[22rem]">
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm"
                aria-label="Фильтр по категории"
                title="Фильтр по категории (включает подкатегории)"
              >
                <option value="">Категория: все</option>
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
                  aria-label="Сортировка списка заявок"
                >
                  <option value="id_desc">ID ↓ (новые сверху)</option>
                  <option value="id_asc">ID ↑</option>
                  <option value="opened_desc">Дата открытия ↓</option>
                  <option value="closed_desc">Дата закрытия ↓</option>
                  <option value="priority_desc">Приоритет (high→low)</option>
                </select>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => void downloadPdf()}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-neutral-900 shadow-sm transition hover:bg-neutral-50 disabled:opacity-50"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-red-600" aria-hidden />
                  {pdfBusy ? 'PDF…' : 'PDF'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setReportOpen(true)}
                className="rounded-xl border border-neutral-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-neutral-800 shadow-sm transition hover:bg-neutral-50"
                title="Отчетность по текущему списку (с учетом фильтров/поиска)"
              >
                Отчёт →
              </button>
            </div>
          </div>

          <h2 className="mb-3 text-sm font-semibold text-slate-800">
            Список
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
                aria-label="Отчетность по заявкам"
                onMouseDown={(e) => {
                  if (e.target === e.currentTarget) setReportOpen(false)
                }}
              >
                <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
                  <div className="flex items-center justify-between gap-3 border-b border-slate-200/70 bg-slate-50/70 px-4 py-3">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-[0.12em] text-slate-500">Отчетность</div>
                      <div className="text-sm font-semibold text-slate-900">
                        По текущему списку ({visibleRows.length}{visibleRows.length !== total ? ` из ${total}` : ''})
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                        onClick={() => window.print()}
                        title="Печать/Сохранение в PDF средствами браузера"
                      >
                        Печать / PDF
                      </button>
                      <button
                        type="button"
                        className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-neutral-900"
                        onClick={() => setReportOpen(false)}
                      >
                        Закрыть
                      </button>
                    </div>
                  </div>

                  <div className="p-4 sm:p-5">
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Всего</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-slate-900">
                          {visibleRows.length}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">с учетом поиска/фильтров</div>
                      </div>
                      <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Закрыто</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-slate-900">
                          {visibleRows.filter((r) => r.status === 'done').length}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">статус “Закрыта”</div>
                      </div>
                      <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Со сроком</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-slate-900">
                          {visibleRows.filter((r) => Boolean(r.planned_close_at)).length}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">указана дата закрытия (ожидаемая)</div>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <div className="rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm">
                        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Распределение по статусам</div>
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
                                    <span className="font-medium text-slate-700">{STATUS_RU[x.k] ?? x.k}</span>
                                    <span className="font-mono text-xs font-semibold text-slate-800">
                                      {x.v} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-2 overflow-hidden rounded-full bg-slate-100 ring-1 ring-slate-200/60">
                                    <div
                                      className="h-full rounded-full bg-gradient-to-r from-neutral-800 to-red-700"
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
                        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Распределение по приоритетам</div>
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
                                    <span className="font-medium text-slate-700">{PRIORITY_RU[x.k] ?? x.k}</span>
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
                      Примечание: “Печать / PDF” использует стандартную печать браузера (можно сохранить как PDF).
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {loading ? (
              <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-14 text-center text-sm text-slate-500">
                Загрузка…
              </p>
            ) : visibleRows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-14 text-center text-sm text-slate-500">
                {query.trim()
                  ? 'Ничего не найдено по поиску'
                  : filterStatus
                    ? 'В этом фильтре пока нет заявок'
                    : 'Пока нет заявок'}
              </p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-slate-200/70 bg-white/95 shadow-sm ring-1 ring-slate-200/25">
                <div className="overflow-x-auto">
                  <table className="min-w-[980px] w-full border-collapse text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur supports-[backdrop-filter]:bg-slate-50/80">
                      <tr className="border-b border-slate-200/70 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                        <th
                          className="cursor-pointer px-3 py-2.5"
                          onClick={() => setSortKey((prev) => (prev === 'id_asc' ? 'id_desc' : 'id_asc'))}
                          title="Сортировать по ID"
                        >
                          ID{sortHint('id_asc', 'id_desc')}
                        </th>
                        <th className="px-3 py-2.5">Заголовок</th>
                        <th className="px-3 py-2.5">Инициатор</th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('opened_desc')} title="Сортировать по дате открытия">
                          Дата открытия{sortHint('opened_desc')}
                        </th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('closed_desc')} title="Сортировать по дате закрытия">
                          Дата закрытия{sortHint('closed_desc')}
                        </th>
                        <th className="px-3 py-2.5">Статус</th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('priority_desc')} title="Сортировать по приоритету">
                          Приоритет{sortHint('priority_desc')}
                        </th>
                        <th className="px-3 py-2.5">Категория</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((t) => (
                        <tr
                          key={t.id}
                          data-request-id={t.id}
                          className="border-b border-slate-100/80 bg-white align-top transition hover:bg-zinc-50/60"
                          onClick={() => openRequestForEdit(t)}
                          role="button"
                          title="Редактировать заявку"
                        >
                              <td className="whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold text-slate-700">
                                <button
                                  type="button"
                                  className="rounded-md px-1.5 py-1 text-left hover:bg-slate-100"
                                  title="Найти по этому ID"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const q = t.id
                                    setQuery(String(q))
                                  }}
                                >
                                  {requestDisplayNo(t)}
                                </button>
                              </td>
                              <td className="px-3 py-3">
                                <div className="flex min-w-0 items-start gap-2">
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate font-semibold text-slate-900" title={t.title}>
                                      <span className="mr-2">{t.title}</span>
                                      {t.external_source === 'bitrix24' ? (
                                        <span
                                          className="inline-flex translate-y-[-1px] items-center rounded-md bg-neutral-950 px-1.5 py-0.5 text-[10px] font-bold tracking-[0.12em] text-white"
                                          title={t.external_id ? `Bitrix24: ${t.external_id}` : 'Bitrix24'}
                                        >
                                          B24
                                        </span>
                                      ) : null}
                                    </div>
                                    {t.computer_hostname ? (
                                      <div className="mt-0.5 truncate text-xs text-slate-500" title={t.computer_hostname}>
                                        ПК: {t.computer_hostname}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{t.requester_name || '—'}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">{fmtRuShortDateTime(t.opened_at ?? t.created_at)}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {fmtRuShortDateTime(t.closed_at ?? t.planned_close_at)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs">
                                <span
                                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                    STATUS_PILL[t.status] ?? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                                  }`}
                                >
                                  {STATUS_RU[t.status] ?? t.status}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-700">
                                {PRIORITY_RU[t.priority] ?? t.priority}
                              </td>
                              <td className="px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{t.category || '—'}</span>
                              </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
        ) : null}

        {/* Статистика */}
        {tab === 'stats' ? (
          <div className="stats-report min-w-0 lg:col-span-12">
            <div className="mb-4 rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:mb-3 print:rounded-xl print:border-slate-300 print:bg-white print:p-4 print:shadow-none print:ring-0">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Аналитика</div>
                  <h2 className="mt-1 font-[family-name:var(--font-display)] text-lg font-semibold tracking-tight text-slate-900">
                    Статистика заявок за период
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Фильтры и графики строятся по данным в памяти (сейчас загружено: <span className="font-semibold">{rows.length}</span>).
                  </p>
                  <p className="mt-1 text-xs text-slate-500 print:text-[11px] print:text-slate-700">
                    Период: <span className="font-semibold">{statsPeriodLabel}</span> · Сформировано:{' '}
                    <span className="font-semibold">{new Date().toLocaleString('ru-RU')}</span>
                  </p>
                </div>
                <div className="stats-report-actions flex flex-wrap gap-2 print:hidden">
                  <button
                    type="button"
                    onClick={() => void downloadExecutivePdf()}
                    className="rounded-xl border border-zinc-300 bg-zinc-900 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-black"
                    title="Профессиональный презентационный PDF-отчет (KPI, графики, выводы)"
                  >
                    PDF отчёт (презентация)
                  </button>
                  <button
                    type="button"
                    onClick={() => window.print()}
                    className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
                    title="Печать/сохранение аналитики в PDF средствами браузера"
                  >
                    Печать / PDF
                  </button>
                  <button
                    type="button"
                    onClick={() => void downloadPdf()}
                    className="rounded-xl bg-red-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-red-700"
                    title="Скачать табличный PDF из сервера"
                  >
                    PDF (таблица)
                  </button>
                </div>
              </div>

              <div className="mb-3 grid gap-3 rounded-xl border border-slate-200/80 bg-slate-50/50 p-3 print:hidden lg:grid-cols-12">
                <label className="block lg:col-span-4">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Название отчета</span>
                  <input
                    type="text"
                    value={execReportTitle}
                    onChange={(e) => setExecReportTitle(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                  />
                </label>
                <label className="block lg:col-span-4">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Кому / контекст</span>
                  <input
                    type="text"
                    value={execReportAudience}
                    onChange={(e) => setExecReportAudience(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                  />
                </label>
                <label className="block lg:col-span-4">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Подготовил</span>
                  <input
                    type="text"
                    value={execReportAuthor}
                    onChange={(e) => setExecReportAuthor(e.target.value)}
                    placeholder={user?.full_name || user?.username || 'ФИО'}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                  />
                </label>
                <div className="flex flex-wrap items-center gap-2 lg:col-span-12">
                  <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
                    <input type="checkbox" checked={execIncludeNarrative} onChange={(e) => setExecIncludeNarrative(e.target.checked)} />
                    Выводы
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
                    <input type="checkbox" checked={execIncludeChart} onChange={(e) => setExecIncludeChart(e.target.checked)} />
                    График динамики
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
                    <input type="checkbox" checked={execIncludeDistributions} onChange={(e) => setExecIncludeDistributions(e.target.checked)} />
                    Категории/инициаторы/статусы/приоритеты
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-700">
                    <input type="checkbox" checked={execIncludeAssigneeLoad} onChange={(e) => setExecIncludeAssigneeLoad(e.target.checked)} />
                    Нагрузка по исполнителям
                  </label>
                </div>
              </div>

              <div className="stats-report-controls grid gap-3 sm:grid-cols-2 lg:grid-cols-12 print:hidden">
                <label className="block lg:col-span-2">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">С</span>
                  <input
                    type="date"
                    value={statsFrom}
                    onChange={(e) => setStatsFrom(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                  />
                </label>
                <label className="block lg:col-span-2">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">По</span>
                  <input
                    type="date"
                    value={statsTo}
                    onChange={(e) => setStatsTo(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm"
                  />
                </label>
                <label className="block lg:col-span-3">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Основание даты</span>
                  <select
                    value={statsBasis}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isStatsBasis(next)) setStatsBasis(next)
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm"
                  >
                    <option value="opened">Дата открытия</option>
                    <option value="last_change">Последнее изменение</option>
                    <option value="closed">Фактическая дата закрытия</option>
                  </select>
                </label>
                <label className="block lg:col-span-2">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Группировка</span>
                  <select
                    value={statsGroup}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isStatsGroup(next)) setStatsGroup(next)
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm"
                  >
                    <option value="day">По дням</option>
                    <option value="week">По неделям</option>
                  </select>
                </label>
                <label className="block lg:col-span-2">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">График</span>
                  <select
                    value={statsChartMode}
                    onChange={(e) => {
                      const next = e.target.value
                      if (isStatsChartMode(next)) setStatsChartMode(next)
                    }}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm"
                  >
                    <option value="total">Общий объем</option>
                    <option value="status">По статусам</option>
                  </select>
                </label>
                <label className="block lg:col-span-1">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Топ N</span>
                  <select
                    value={String(statsTopN)}
                    onChange={(e) => setStatsTopN(Math.max(5, Math.min(15, Number(e.target.value) || 8)))}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm"
                  >
                    <option value="6">6</option>
                    <option value="8">8</option>
                    <option value="10">10</option>
                    <option value="12">12</option>
                  </select>
                </label>
                <label className="block lg:col-span-2">
                  <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Сортировка таблицы</span>
                  <select
                    value={sortKey}
                    onChange={(e) => setSortKey(e.target.value as SortKey)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-900 shadow-sm"
                  >
                    <option value="id_desc">ID (по убыванию)</option>
                    <option value="id_asc">ID (по возрастанию)</option>
                    <option value="opened_desc">Дата открытия (новые сверху)</option>
                    <option value="closed_desc">Дата закрытия (новые сверху)</option>
                    <option value="priority_desc">Приоритет (высокий сверху)</option>
                    <option value="id_desc">ID (по убыванию)</option>
                    <option value="id_asc">ID (по возрастанию)</option>
                  </select>
                </label>
                <div className="flex flex-wrap items-end gap-3 lg:col-span-2">
                  <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={statsOnlyWithPlanned}
                      onChange={(e) => setStatsOnlyWithPlanned(e.target.checked)}
                    />
                    <span className="text-sm font-medium text-slate-700">Только со сроком закрытия</span>
                  </label>
                  <label className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={statsOnlyOverdue}
                      onChange={(e) => setStatsOnlyOverdue(e.target.checked)}
                    />
                    <span className="text-sm font-medium text-slate-700">Просроченные</span>
                  </label>
                </div>
              </div>
            </div>

            <div className="stats-report-grid grid gap-4 lg:grid-cols-12 print:gap-3">
              <div className="lg:col-span-4">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3">
                    <span className="h-8 w-1 rounded-full bg-red-600/90" aria-hidden />
                    <h3 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                      KPI периода
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <MiniStatCard label="В периоде" value={statsRows.length} variant="neutral" icon={<IconTicket className="h-5 w-5" />} />
                    <MiniStatCard
                      label="Закрыто"
                      value={statsKpi.done}
                      sub={`${statsKpi.completionRate}% от всех`}
                      variant="neutral"
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                    <MiniStatCard
                      label="Просроченных"
                      value={statsKpi.overdue}
                      sub={`${statsKpi.overdueRate}% от всех`}
                      variant="neutral"
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                    <MiniStatCard
                      label="Среднее закрытие"
                      value={statsKpi.avgCloseHours != null ? `${statsKpi.avgCloseHours} ч` : '—'}
                      sub="От даты открытия до фактического закрытия"
                      variant="neutral"
                      compact
                      icon={<IconTicket className="h-5 w-5" />}
                    />
                    <MiniStatCard
                      label="SLA в срок"
                      value={`${statsKpi.slaHitRate}%`}
                      sub="Закрытые в плановую дату или раньше"
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
                      Динамика (объём заявок)
                    </h3>
                  </div>

                  {statsSeries.items.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-12 text-center text-sm text-slate-500">
                      Нет данных за выбранный период
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
                            ? 'дата открытия'
                            : statsBasis === 'closed'
                              ? 'фактическая дата закрытия'
                              : 'последнее изменение'}
                        </span>
                        , группировка: <span className="font-medium">{statsGroup === 'day' ? 'дни' : 'недели'}</span>.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">По категориям (топ)</div>
                  <DonutDistribution
                    items={topNWithOther(
                      statsCategoryItems,
                      statsTopN,
                      'Остальные категории',
                    )}
                    emptyText="Нет категорий"
                    compact
                  />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-neutral-500">По инициаторам (топ)</div>
                  <DonutDistribution
                    items={topNWithOther(
                      statsRequesterItems,
                      statsTopN,
                      'Остальные пользователи',
                    )}
                    emptyText="Нет инициаторов"
                    compact
                  />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <HorizontalBars
                    title="По статусам"
                    items={topNWithOther(statsStatusItems, 6, 'Другие статусы')}
                    total={statsRows.length}
                  />
                </div>
              </div>

              <div className="lg:col-span-6">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <HorizontalBars
                    title="По приоритетам"
                    items={topNWithOther(statsPriorityItems, 6, 'Другие')}
                    total={statsRows.length}
                  />
                </div>
              </div>

              <div className="lg:col-span-12">
                <div className="stats-report-card rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6 print:rounded-lg print:border-slate-300 print:p-3 print:shadow-none print:ring-0">
                  <HorizontalBars
                    title="Нагрузка по исполнителям (топ)"
                    items={topNWithOther(statsAssigneeItems, statsTopN, 'Остальные исполнители')}
                    total={Math.max(1, statsRows.reduce((acc, r) => acc + (r.assignee_usernames?.length || 1), 0))}
                  />
                </div>
              </div>

              <div className="lg:col-span-12">
                <div className="rounded-2xl border border-slate-200/70 bg-white/95 p-5 shadow-sm ring-1 ring-slate-200/30 sm:p-6">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="h-8 w-1 rounded-full bg-red-600/90" aria-hidden />
                      <h3 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                        Заявки за период
                      </h3>
                    </div>
                    <span className="text-xs font-medium text-slate-500">
                      {statsRows.length}{' '}
                      {statsRows.length === 1 ? 'заявка' : statsRows.length >= 2 && statsRows.length <= 4 ? 'заявки' : 'заявок'}
                    </span>
                  </div>

                  {statsRows.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-10 text-center text-sm text-slate-500">
                      Нет заявок за выбранный период
                    </p>
                  ) : (
                    <div className="overflow-x-auto rounded-xl border border-slate-200/70 print:rounded-md print:border-slate-300">
                      <table className="min-w-[880px] w-full border-collapse text-left text-sm print:min-w-0 print:text-xs">
                        <thead className="bg-slate-50/95 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                          <tr className="border-b border-slate-200/70">
                            <th className="px-3 py-2.5">ID</th>
                            <th className="px-3 py-2.5">Заголовок</th>
                            <th className="px-3 py-2.5">Статус</th>
                            <th className="px-3 py-2.5">Инициатор</th>
                            <th className="px-3 py-2.5">Дата открытия</th>
                            <th className="px-3 py-2.5">Дата закрытия</th>
                            <th className="px-3 py-2.5">Приоритет</th>
                            <th className="px-3 py-2.5">Категория</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statsRows.map((t) => (
                            <tr
                              key={t.id}
                              className="cursor-pointer border-b border-slate-100/80 bg-white align-top transition hover:bg-zinc-50/60"
                              onClick={() => openRequestForEdit(t)}
                              title="Редактировать заявку"
                            >
                              <td className="whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold text-slate-700">
                                {requestDisplayNo(t)}
                              </td>
                              <td className="max-w-[240px] px-3 py-3">
                                <div className="truncate font-semibold text-slate-900" title={t.title}>
                                  {t.title}
                                </div>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs">
                                <span
                                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                    STATUS_PILL[t.status] ?? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'
                                  }`}
                                >
                                  {STATUS_RU[t.status] ?? t.status}
                                </span>
                              </td>
                              <td className="max-w-[140px] px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{t.requester_name || '—'}</span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {fmtRuShortDateTime(t.opened_at ?? t.created_at)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-600">
                                <span className="font-medium text-slate-800">
                                  {fmtRuShortDateTime(t.closed_at ?? t.planned_close_at)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-slate-700">
                                {PRIORITY_RU[t.priority] ?? t.priority}
                              </td>
                              <td className="max-w-[180px] px-3 py-3 text-xs text-slate-700">
                                <span className="line-clamp-2">{t.category || '—'}</span>
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
            {err ? (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-900">
                {err}
              </div>
            ) : null}

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <div className="app-card rounded-2xl border-slate-200/70 p-5 sm:p-6">
                  <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3">
                    <span className="h-8 w-1 rounded-full bg-red-600/90" aria-hidden />
                    <h2 className="font-[family-name:var(--font-display)] text-base font-semibold tracking-tight text-slate-900">
                      {tplEditingId != null ? 'Редактирование шаблона' : 'Новый шаблон'}
                    </h2>
                    {tplEditingId != null ? (
                      <span className="rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900 ring-1 ring-amber-200/80">
                        #{tplEditingId}
                      </span>
                    ) : null}
                  </div>

                  <label className="mb-3 block">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Название шаблона
                    </span>
                    <input
                      value={tplTitle}
                      onChange={(e) => setTplTitle(e.target.value)}
                      className="w-full rounded-xl border border-slate-200/90 bg-white px-3 py-2.5 text-sm text-slate-900 shadow-sm placeholder:text-slate-400"
                      placeholder="Например: Замена монитора / Установка ПО"
                    />
                  </label>

                  <label className="mb-3 block">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Описание (необязательно)
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
                      label="Инициатор (по умолчанию)"
                      placeholder="Начните вводить и выберите из списка"
                      hint="Тот же список, что у ответственных по шаблону."
                    />
                    <CategoryPicker
                      value={tplCategory}
                      onChange={setTplCategory}
                      tree={categoryTree}
                      label="Категория (по умолчанию)"
                    />
                  </div>

                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Статус по умолчанию
                      </span>
                      <select
                        value={tplStatus}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestStatus(next)) setTplStatus(next)
                        }}
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900"
                      >
                        {Object.entries(STATUS_RU).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Приоритет по умолчанию
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
                            {PRIORITY_RU[p]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Дата открытия
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
                        Дата закрытия
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
                        title={`Через ${p.label} от даты открытия шаблона (горячая клавиша ${p.hotkey})`}
                        onClick={() => setTplPlannedCloseLocal(addMinutesToLocalDatetimeValue(tplOpenedAtLocal, p.minutes))}
                      >
                        +{p.label}
                      </button>
                    ))}
                  </div>
                    </label>
                  </div>

                  <label className="mb-3 block">
                    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Фактическая дата закрытия
                    </span>
                    <label className="mb-2 flex cursor-pointer items-center gap-2 rounded-md border border-slate-100 bg-slate-50/80 px-2 py-1.5">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-red-600 focus:ring-red-500/30"
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
                        Фактическая дата закрытия = дата закрытия
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
                    inputClassName="w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 transition focus:border-zinc-500 focus:ring-2 focus:ring-red-500/15"
                    hint="Клик по строке в списке добавляет или убирает исполнителя. Справочник тот же, что у инициатора."
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
                        Отмена
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={tplBusy || !tplTitle.trim()}
                      onClick={() => void saveTemplateFromForm()}
                      className="w-full flex-1 rounded-xl bg-red-600 py-3 text-sm font-semibold text-white shadow-md shadow-red-600/20 transition hover:bg-red-700 disabled:opacity-50"
                    >
                      {tplBusy ? 'Сохранение…' : tplEditingId != null ? 'Сохранить изменения' : 'Сохранить шаблон'}
                    </button>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-8">
                <div className="mb-3 flex items-end justify-between gap-3">
                  <h2 className="text-sm font-semibold text-slate-800">
                    Шаблоны
                    {!tplLoading ? <span className="ml-2 font-normal text-slate-500">· {tplTotal}</span> : null}
                  </h2>
                  <button
                    type="button"
                    disabled={tplLoading}
                    onClick={() => void loadTemplates()}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Обновить
                  </button>
                </div>

                <div className="space-y-3">
                  {tplLoading ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-14 text-center text-sm text-slate-500">
                      Загрузка…
                    </p>
                  ) : tplRows.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 py-14 text-center text-sm text-slate-500">
                      Пока нет шаблонов
                    </p>
                  ) : (
                    tplRows.map((t) => (
                      <article
                        key={t.id}
                        className="rounded-2xl border border-slate-200/70 bg-white/95 px-4 py-4 shadow-sm ring-1 ring-slate-200/25"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="font-semibold text-slate-900">{t.title}</h3>
                              <span
                                className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${STATUS_PILL[t.status] ?? 'bg-slate-100 text-slate-700 ring-1 ring-slate-200'}`}
                              >
                                {STATUS_RU[t.status] ?? t.status}
                              </span>
                            </div>
                            {t.description ? (
                              <p className="mt-2 text-sm leading-relaxed text-slate-600">{t.description}</p>
                            ) : null}
                            {t.requester_name || t.category ? (
                              <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-slate-600">
                                {t.requester_name ? (
                                  <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200/80">
                                    Инициатор: <span className="font-semibold text-slate-800">{t.requester_name}</span>
                                  </span>
                                ) : null}
                                {t.category ? (
                                  <span className="rounded-full bg-white px-3 py-1 ring-1 ring-slate-200/80">
                                    Категория: <span className="font-semibold text-slate-800">{t.category}</span>
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="mt-2 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-slate-500">
                              <span>{t.created_by_username}</span>
                              {t.assignee_usernames && t.assignee_usernames.length > 0 ? (
                                <span className="font-medium text-slate-700" title={t.assignee_usernames.join(', ')}>
                                  → {t.assignee_usernames.join(', ')}
                                </span>
                              ) : null}
                              {t.computer_id ? <span className="text-slate-500">· ПК: {t.computer_id}</span> : null}
                              <span>· {PRIORITY_RU[t.priority] ?? t.priority}</span>
                            </div>
                            <div className="mt-2 grid grid-cols-1 gap-1 rounded-lg bg-slate-50/90 px-2 py-2 text-[11px] text-slate-600 ring-1 ring-slate-100 sm:grid-cols-3">
                              <span>
                                Дата открытия:{' '}
                                <span className="font-medium text-slate-800">{fmtRuDateTime(t.opened_at)}</span>
                              </span>
                              <span>
                                Дата закрытия:{' '}
                                <span className="font-medium text-slate-800">{fmtRuDateTime(t.planned_close_at)}</span>
                              </span>
                              <span>
                                Фактическая дата закрытия:{' '}
                                <span className="font-medium text-slate-800">{fmtRuDateTime(t.closed_at)}</span>
                              </span>
                            </div>
                          </div>
                          <div className="flex shrink-0 flex-col gap-2 sm:items-end">
                            <button
                              type="button"
                              onClick={() => beginEditTemplate(t)}
                              className="min-h-[40px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50"
                            >
                              Редактировать
                            </button>
                            <button
                              type="button"
                              onClick={() => applyTemplateToForm(t)}
                              className="min-h-[40px] rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-red-700"
                            >
                              Применить
                            </button>
                            <button
                              type="button"
                              disabled={tplBusy}
                              onClick={() => void deleteTemplate(t.id, t.title)}
                              className="min-h-[40px] rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
                            >
                              Удалить
                            </button>
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
