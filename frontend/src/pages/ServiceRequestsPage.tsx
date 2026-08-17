import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
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
import { IconPencil, IconTrash } from '../components/icons'
import { collectCategoryPaths } from '../requestCategories'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import {
  REQUEST_STATUSES,
  REQUEST_PRIORITIES,
  CREATE_FORM_INPUT_CLS,
  CREATE_FORM_LABEL_CLS,
  STATUS_PILL,
  DB_PAGE_SIZE_KEY,
  DB_PAGE_SIZE_OPTIONS,
  DURATION_PRESETS_MIN,
  type RequestStatus,
  type RequestPriority,
  type StatsBasis,
  type StatsGroup,
  type StatsChartMode,
  type RequestsTabId,
  type SortKey,
  isRequestStatus,
  isRequestPriority,
  readDatabasePageSize,
  sortArrow,
  getAppScrollContainer,
  captureListScrollForRestore,
  scheduleListScrollRestore,
  readRecentTitles,
  pushRecentTitle,
  removeRecentTitle,
  parseIsoToDate,
  toDatetimeLocalValue,
  fromDatetimeLocalValue,
  fmtRuShortDateTime,
  requestStatusLabel,
  requestPriorityLabel,
  durationPresetLabel,
  requestPluralLabel,
  requestDisplayNo,
  compareRequestId,
  pickLastChangeIso,
  CategoryPicker,
  defaultOpenedLocal,
  defaultPlannedCloseLocal,
  addMinutesToLocalDatetimeValue,
  topNWithOther,
  DonutDistribution,
  HorizontalBars,
  ComputerPicker,
  userDirectoryLabel,
  DirectoryRequesterPicker,
  DirectoryAssigneesPicker,
  takeSkipNextListReload,
  markSkipNextListReload,
} from './service-requests/shared'

const RequestsStatsLineChart = lazy(() => import('./service-requests/RequestsStatsLineChart'))

export function ServiceRequestsPage() {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
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
  const [alignDatesBusy, setAlignDatesBusy] = useState(false)
  const [dbShowAll, setDbShowAll] = useState(false)
  const [dbPage, setDbPage] = useState(1)
  const [dbPageSize, setDbPageSize] = useState(readDatabasePageSize)

  const [pcList, setPcList] = useState<Computer[]>([])
  const [categoryTree, setCategoryTree] = useState<RequestCategoryTreeNode[]>([])
  const categoryPaths = useMemo(() => collectCategoryPaths(categoryTree), [categoryTree])
  const [userDir, setUserDir] = useState<UserDirectoryItem[]>([])
  const [recentTitles, setRecentTitles] = useState<string[]>(() =>
    typeof localStorage !== 'undefined' ? readRecentTitles() : [],
  )
  const [title, setTitle] = useState('')
  const [aiTitleSuggestion, setAiTitleSuggestion] = useState('')
  const [aiSuggestBusy, setAiSuggestBusy] = useState(false)
  const [description, setDescription] = useState('')
  const [showDescription, setShowDescription] = useState(false)
  const [requesterName, setRequesterName] = useState('')
  const [category, setCategory] = useState('')
  const [createStatus, setCreateStatus] = useState<RequestStatus>('open')
  const [priority, setPriority] = useState<RequestPriority>('normal')
  const [requestLocation, setRequestLocation] = useState('')
  const [openedAtLocal, setOpenedAtLocal] = useState(defaultOpenedLocal())
  const [plannedCloseLocal, setPlannedCloseLocal] = useState('')
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
  const [editingReturnPage, setEditingReturnPage] = useState<number | null>(null)
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
      if (sortKey === asc) return <span className="ml-1 text-[var(--color-fg-muted)]">↑</span>
      if (sortKey === desc) return <span className="ml-1 text-[var(--color-fg-muted)]">↓</span>
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

  const statsAssigneeDetail = useMemo(() => {
    const map = new Map<string, { total: number; done: number; active: number; hours: number[] }>()
    for (const r of statsRows) {
      const names = r.assignee_usernames?.length ? r.assignee_usernames : [t('requests.statsData.noAssignee')]
      for (const n of names) {
        const cur = map.get(n) ?? { total: 0, done: 0, active: 0, hours: [] }
        cur.total += 1
        if (r.status === 'done') {
          cur.done += 1
          const opened = parseIsoToDate(r.opened_at ?? r.created_at)
          const closed = parseIsoToDate(r.closed_at ?? '')
          if (opened && closed) {
            const h = (closed.getTime() - opened.getTime()) / 3_600_000
            if (Number.isFinite(h) && h >= 0) cur.hours.push(h)
          }
        }
        if (r.status === 'open' || r.status === 'in_progress') cur.active += 1
        map.set(n, cur)
      }
    }
    return [...map.entries()]
      .map(([name, v]) => ({
        name,
        count: v.total,
        done: v.done,
        active: v.active,
        avgHours: v.hours.length
          ? Math.round((v.hours.reduce((a, b) => a + b, 0) / v.hours.length) * 10) / 10
          : null,
      }))
      .sort((a, b) => b.count - a.count)
  }, [statsRows, t])

  const statsAssigneeLoadTotal = useMemo(
    () => statsAssigneeDetail.reduce((s, r) => s + r.count, 0),
    [statsAssigneeDetail],
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
    const cancelled = statsRows.filter((r) => r.status === 'cancelled').length
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
      .filter((r) => r.status === 'done')
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
    return { total, done, cancelled, active, overdue, completionRate, overdueRate, avgCloseHours, slaHitRate }
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
      { key: 'open', label: t('requests.statsData.openSeries'), color: '#2563eb', bg: 'rgb(37 99 235 / 0.12)' },
      { key: 'in_progress', label: t('requests.statsData.inProgressSeries'), color: '#60a5fa', bg: 'rgb(96 165 250 / 0.12)' },
      { key: 'done', label: t('requests.statsData.doneSeries'), color: '#93c5fd', bg: 'rgb(147 197 253 / 0.12)' },
      { key: 'cancelled', label: t('requests.statsData.cancelledSeries'), color: '#94a3b8', bg: 'rgb(148 163 184 / 0.12)' },
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

  const dbPageCount = useMemo(() => {
    if (dbShowAll) return 1
    const n =
      tab === 'database' &&
      !query.trim() &&
      !filterCategory.trim() &&
      sortKey === 'id_desc'
        ? total
        : visibleRows.length
    return Math.max(1, Math.ceil(n / dbPageSize))
  }, [
    dbShowAll,
    dbPageSize,
    filterCategory,
    query,
    sortKey,
    tab,
    total,
    visibleRows.length,
  ])

  const dbRowsToRender = useMemo(() => {
    if (tab !== 'database') return visibleRows
    if (dbShowAll) return visibleRows
    const serverPaged =
      !query.trim() && !filterCategory.trim() && sortKey === 'id_desc'
    if (serverPaged) return visibleRows
    const p = Math.min(dbPage, dbPageCount)
    const start = (p - 1) * dbPageSize
    return visibleRows.slice(start, start + dbPageSize)
  }, [tab, visibleRows, dbPage, dbPageCount, dbPageSize, dbShowAll, query, filterCategory, sortKey])

  const load = useCallback(async () => {
    if (takeSkipNextListReload() && (tab === 'database' || tab === 'stats')) {
      return
    }
    setLoading(true)
    try {
      const editId = searchParams.get('edit')
      const clientFiltered = Boolean(query.trim() || filterCategory.trim())
      const needAll =
        tab === 'stats' || Boolean(editId) || dbShowAll || clientFiltered || sortKey !== 'id_desc'
      const r = await api.serviceRequests({
        limit: needAll ? 1000 : dbPageSize,
        skip: needAll ? 0 : (dbPage - 1) * dbPageSize,
        ...(filterStatus && !editId ? { status: filterStatus } : {}),
      })
      setRows(r.items)
      setTotal(r.total)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setLoading(false)
    }
  }, [
    dbPage,
    dbPageSize,
    dbShowAll,
    filterCategory,
    filterStatus,
    query,
    searchParams,
    sortKey,
    tab,
    t,
    toast,
  ])

  useEffect(() => {
    const raw = searchParams.get('edit')
    if (!raw) return
    const id = Number.parseInt(raw, 10)
    if (!Number.isFinite(id) || id <= 0) return
    if (loading) return
    const fromState = (location.state as { editRequest?: ServiceRequestRow } | null)?.editRequest
    const row = fromState?.id === id ? fromState : rows.find((r) => r.id === id)
    if (!row) {
      if (loading) return
      if (rows.length) toast.error(t('requests.errors.editNotFound'))
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('edit')
          return next
        },
        { replace: true },
      )
      return
    }
    populateFormFromRequest(row)
    setEditingRequestId(row.id)
    setEditingReturnPath('/requests/database')
    setEditingReturnPage(1)
    setEditDeleteConfirm(false)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('edit')
        return next
      },
      { replace: true },
    )
    if (location.pathname !== '/requests') navigate('/requests', { replace: true })
    window.requestAnimationFrame(() => {
      const el = getAppScrollContainer()
      if (el) el.scrollTop = 0
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows, searchParams, location.state])

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
  }, [loading, tab, location.pathname, visibleRows.length, dbPage])

  useEffect(() => {
    setDbPage(1)
  }, [query, filterCategory, filterStatus, sortKey])

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

  const myIdentityIds = useMemo(() => {
    const ids: number[] = []
    if (!user) return ids
    if (user.linked_directory_user_id) ids.push(user.linked_directory_user_id)
    else ids.push(user.id)
    return ids
  }, [user])

  const myRequesterDefault = useMemo(() => {
    if (!user) return ''
    if (user.linked_directory_full_name?.trim()) return user.linked_directory_full_name.trim()
    if (user.linked_directory_username?.trim()) return user.linked_directory_username.trim()
    return (user.full_name || user.username || '').trim()
  }, [user])

  useEffect(() => {
    if (tab !== 'create' || editingRequestId != null) return
    if (assigneeIds.length === 0 && myIdentityIds.length > 0) {
      setAssigneeIds(myIdentityIds)
    }
    if (!requesterName.trim() && myRequesterDefault) {
      setRequesterName(myRequesterDefault)
    }
    // Only seed once identity is known; don't fight user edits after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional one-shot defaults when identity arrives
  }, [tab, editingRequestId, user?.id, user?.linked_directory_user_id, myRequesterDefault])

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
    if (createStatus !== 'done' && createStatus !== 'cancelled') return
    setClosedAtLocal(plannedCloseLocal)
  }, [closedSameAsPlanned, plannedCloseLocal, createStatus])

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
    setPlannedCloseLocal('')
    setClosedAtLocal('')
    setClosedSameAsPlanned(true)
    setAssigneeIds(myIdentityIds.length ? [...myIdentityIds] : [])
    setComputerId('')
    setRequesterName(myRequesterDefault)
    setCategory('')
    setAiTitleSuggestion('')
    setShowDescription(false)
    setEditingRequestId(null)
    setEditingReturnPath(null)
    setEditingReturnPage(null)
    setEditDeleteConfirm(false)
  }

  function populateFormFromRequest(t: ServiceRequestRow) {
    setTitle(t.title ?? '')
    setAiTitleSuggestion((t.ai_title_suggestion ?? '').trim())
    setDescription(t.description ?? '')
    setShowDescription(Boolean(t.description?.trim()))
    setRequesterName((t.requester_name ?? '').trim())
    setCategory((t.category ?? '').trim())
    setRequestLocation((t.location ?? '').trim())
    const status = isRequestStatus(t.status) ? t.status : 'open'
    setCreateStatus(status)
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
    const isClosedLike = status === 'done' || status === 'cancelled'
    if (status === 'open') {
      setPlannedCloseLocal('')
      setClosedAtLocal('')
      setClosedSameAsPlanned(true)
    } else if (isClosedLike) {
      const closeVal = closed || planned || defaultOpenedLocal()
      const datesMatch = !planned || !closed || planned === closed
      setPlannedCloseLocal(datesMatch ? closeVal : planned)
      setClosedAtLocal(datesMatch ? closeVal : closed)
      setClosedSameAsPlanned(datesMatch)
    } else {
      setPlannedCloseLocal(planned)
      setClosedAtLocal('')
      setClosedSameAsPlanned(true)
    }
  }

  function navigateBackToList(returnPath: string | null, returnPage: number | null) {
    if (!returnPath || returnPath === '/requests') return
    markSkipNextListReload()
    if (returnPage != null) setDbPage(returnPage)
    navigate(returnPath)
  }

  function openRequestForEdit(t: ServiceRequestRow) {
    captureListScrollForRestore(t.id, location.pathname)
    populateFormFromRequest(t)
    setEditingRequestId(t.id)
    setEditingReturnPath(location.pathname)
    setEditingReturnPage(dbPage)
    setEditDeleteConfirm(false)
    navigate('/requests')
    window.requestAnimationFrame(() => {
      const el = getAppScrollContainer()
      if (el) el.scrollTop = 0
    })
  }

  function cancelEditing() {
    const returnPath = editingReturnPath
    const returnPage = editingReturnPage
    setTitle('')
    setDescription('')
    resetCreateFormAfterSubmit()
    navigateBackToList(returnPath, returnPage)
  }

  async function onSubmitRequest(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) return
    if (!openedAtLocal.trim()) {
      toast.error(t('requests.errors.openedRequired'))
      return
    }
    setSaving(true)
    try {
      const isOpenLike = createStatus === 'open' || createStatus === 'in_progress'
      const isClosedLike = createStatus === 'done' || createStatus === 'cancelled'
      const plannedValue =
        createStatus === 'open' ? '' : plannedCloseLocal.trim()
      const closedLocalValue = isClosedLike
        ? closedSameAsPlanned
          ? plannedCloseLocal
          : closedAtLocal
        : ''
      const closedParsed = closedLocalValue.trim() ? fromDatetimeLocalValue(closedLocalValue) : null
      if (isClosedLike && !closedParsed) {
        toast.error(t('requests.errors.closedRequired'))
        setSaving(false)
        return
      }
      const body = {
        title: title.trim(),
        description: description.trim() || null,
        status: createStatus,
        priority,
        location: requestLocation.trim() || null,
        requester_name: requesterName.trim() || null,
        category: category.trim() || null,
        computer_id: computerId ? Number(computerId) : null,
        assignee_ids: assigneeIds,
        opened_at: fromDatetimeLocalValue(openedAtLocal),
        planned_close_at: plannedValue ? fromDatetimeLocalValue(plannedValue) : null,
        closed_at: isOpenLike ? null : closedParsed,
      }

      if (editingRequestId != null) {
        const updated = await api.updateServiceRequest(editingRequestId, {
          ...body,
          closed_at: body.closed_at,
        })
        const returnPath = editingReturnPath
        const returnPage = editingReturnPage
        setRows((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
        setTitle('')
        setDescription('')
        resetCreateFormAfterSubmit()
        toast.ok(t('requests.messages.saved'))
        void refreshSummary()
        window.dispatchEvent(new Event('corax:assignee-notifications'))
        if (returnPath && returnPath !== '/requests') navigateBackToList(returnPath, returnPage)
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
        window.dispatchEvent(new Event('corax:assignee-notifications'))
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

  async function alignPlannedToClosedDates() {
    if (alignDatesBusy) return
    const targets = rows.filter((r) => Boolean(r.closed_at) && (r.planned_close_at ?? '') !== (r.closed_at ?? ''))
    if (!targets.length) {
      toast.info(t('requests.database.alignDatesNone'))
      return
    }
    if (!window.confirm(t('requests.database.alignDatesConfirm', { count: targets.length }))) return
    setAlignDatesBusy(true)
    try {
      const chunk = 6
      for (let i = 0; i < targets.length; i += chunk) {
        await Promise.all(
          targets.slice(i, i + chunk).map((r) =>
            api.updateServiceRequest(r.id, { planned_close_at: r.closed_at }),
          ),
        )
      }
      toast.ok(t('requests.database.alignDatesDone', { count: targets.length }))
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('requests.errors.generic'))
    } finally {
      setAlignDatesBusy(false)
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
      const categoryTop = topNWithOther(statsCategoryItems, statsTopN, t('requests.statsData.otherCategories')).slice(0, statsTopN)
      const requesterTop = topNWithOther(statsRequesterItems, statsTopN, t('requests.statsData.otherUsers')).slice(0, statsTopN)
      const assigneeTop = statsAssigneeItems.slice(0, 20)
      const statusTop = topNWithOther(statsStatusItems, 8, t('requests.statsData.otherStatuses'))
      const priorityTop = topNWithOther(statsPriorityItems, 8, t('requests.statsData.otherPriorities'))
      const loc = locale === 'en' ? 'en-GB' : 'ru-RU'
      const nowText = new Date().toLocaleString(loc, { dateStyle: 'long', timeStyle: 'short' })
      const title = execReportTitle.trim() || t('requests.reportDefaults.title')
      const basisText =
        statsBasis === 'opened'
          ? t('requests.stats.basisOpenedLower')
          : statsBasis === 'closed'
            ? t('requests.stats.basisClosedLower')
            : t('requests.stats.basisLastChangeLower')
      const groupText = statsGroup === 'day' ? t('requests.stats.groupDays') : t('requests.stats.groupWeeks')
      const avgText =
        statsKpi.avgCloseHours != null ? t('requests.stats.pdfHours', { h: statsKpi.avgCloseHours }) : '—'
      const fmtBound = (iso: string) => {
        if (!iso.trim()) return ''
        const d = new Date(`${iso.trim()}T00:00:00`)
        return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(loc, { day: 'numeric', month: 'long', year: 'numeric' })
      }
      const fromPretty = fmtBound(statsFrom) || t('requests.stats.pdfAllPeriod')
      const toPretty = fmtBound(statsTo) || t('requests.statsData.today')
      const periodPretty = statsFrom.trim() || statsTo.trim() ? `${fromPretty} — ${toPretty}` : t('requests.stats.pdfAllPeriod')
      const narrative = [
        t('requests.stats.narrativeTotal', { total: statsKpi.total, done: statsKpi.done, pct: statsKpi.completionRate }),
        t('requests.stats.narrativeCancelled', { count: statsKpi.cancelled }),
        t('requests.stats.narrativeOverdue', { count: statsKpi.overdue, pct: statsKpi.overdueRate }),
        t('requests.stats.narrativeSla', { avg: avgText, sla: statsKpi.slaHitRate }),
      ]
      const palette = ['#1e3a5f', '#2563eb', '#0f766e', '#c2410c', '#7c3aed', '#be123c', '#475569', '#0891b2']
      const polar = (cx: number, cy: number, r: number, deg: number) => {
        const rad = ((deg - 90) * Math.PI) / 180
        return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
      }
      const slicePath = (start: number, end: number) => {
        const large = end - start > 180 ? 1 : 0
        const p1 = polar(80, 80, 74, start)
        const p2 = polar(80, 80, 74, end)
        const p3 = polar(80, 80, 46, end)
        const p4 = polar(80, 80, 46, start)
        return `M ${p1.x.toFixed(2)} ${p1.y.toFixed(2)} A 74 74 0 ${large} 1 ${p2.x.toFixed(2)} ${p2.y.toFixed(2)} L ${p3.x.toFixed(2)} ${p3.y.toFixed(2)} A 46 46 0 ${large} 0 ${p4.x.toFixed(2)} ${p4.y.toFixed(2)} Z`
      }
      const nonempty = (items: { name: string; count: number }[]) => items.filter((i) => i.count > 0)
      const donutBlock = (heading: string, items: { name: string; count: number }[]) => {
        const rows = nonempty(items)
        if (!rows.length) return ''
        const total = rows.reduce((s, i) => s + i.count, 0)
        const gap = rows.length <= 1 ? 0 : 1.2
        const usable = 360 - rows.length * gap
        let cursor = 0
        const paths = rows
          .map((item, i) => {
            const span = rows.length === 1 ? 360 : Math.max(0.8, (item.count / total) * usable)
            const start = cursor
            const end = cursor + span
            cursor = end + gap
            const color = palette[i % palette.length]
            if (rows.length === 1) {
              return `<circle cx="80" cy="80" r="60" fill="none" stroke="${color}" stroke-width="28"/>`
            }
            return `<path d="${slicePath(start, end)}" fill="${color}"/>`
          })
          .join('')
        const legend = rows
          .map((item, i) => {
            const pct = Math.round((item.count / total) * 100)
            return `<div class="leg"><span class="dot" style="background:${palette[i % palette.length]}"></span><span class="nm">${escapeHtml(item.name)}</span><span class="nmr">${item.count} · ${pct}%</span></div>`
          })
          .join('')
        const center = `<circle cx="80" cy="80" r="40" fill="#ffffff"/>
          <text x="80" y="76" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700" fill="#0f172a">${total}</text>
          <text x="80" y="96" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="#64748b">${escapeHtml(t('requests.charts.total'))}</text>`
        return `<article class="chart-card">
          <h2>${escapeHtml(heading)}</h2>
          <div class="donut-row">
            <svg viewBox="0 0 160 160" width="148" height="148">${paths}${center}</svg>
            <div class="legend">${legend}</div>
          </div>
        </article>`
      }
      const barsBlock = (heading: string, items: { name: string; count: number }[], totalForPct: number) => {
        const rows = nonempty(items)
        if (!rows.length) return ''
        const tot = totalForPct > 0 ? totalForPct : rows.reduce((s, i) => s + i.count, 0)
        const rowsHtml = rows
          .map((item, i) => {
            const pct = tot > 0 ? Math.round((item.count / tot) * 100) : 0
            return `<div class="row"><div class="row-top"><span>${escapeHtml(item.name)}</span><span>${item.count} · ${pct}%</span></div><div class="bar"><i style="width:${Math.max(3, pct)}%;background:${palette[i % palette.length]}"></i></div></div>`
          })
          .join('')
        return `<article class="chart-card"><h2>${escapeHtml(heading)}</h2>${rowsHtml}</article>`
      }
      const statusDonut = execIncludeDistributions ? donutBlock(t('requests.stats.byStatuses'), statusTop) : ''
      const priorityDonut = execIncludeDistributions ? donutBlock(t('requests.stats.byPriorities'), priorityTop) : ''
      const categoryDonut = execIncludeDistributions ? donutBlock(t('requests.stats.byCategoryTop'), categoryTop) : ''
      const requesterDonut = execIncludeDistributions ? donutBlock(t('requests.stats.byRequesterTop'), requesterTop) : ''
      const assigneeBars = execIncludeAssigneeLoad
        ? barsBlock(
            t('requests.stats.assigneeLoadTop'),
            assigneeTop,
            Math.max(1, assigneeTop.reduce((a, b) => a + b.count, 0)),
          )
        : ''
      const assigneeRows = execIncludeAssigneeLoad ? statsAssigneeDetail.slice(0, 20) : []
      const assigneeTotal = statsAssigneeDetail.reduce((s, r) => s + r.count, 0)
      const assigneeTable =
        assigneeRows.length > 0
          ? `<section class="sec">
        <h2>${escapeHtml(t('requests.stats.assigneeBoard'))}</h2>
        <table class="tbl">
          <thead><tr>
            <th>${escapeHtml(t('requests.stats.assigneeName'))}</th>
            <th class="num">${escapeHtml(t('requests.stats.assigneeTickets'))}</th>
            <th class="num">${escapeHtml(t('requests.stats.assigneeShare'))}</th>
            <th class="num">${escapeHtml(t('requests.stats.assigneeDone'))}</th>
            <th class="num">${escapeHtml(t('requests.stats.assigneeActive'))}</th>
            <th class="num">${escapeHtml(t('requests.stats.assigneeAvg'))}</th>
          </tr></thead>
          <tbody>${assigneeRows
            .map((r) => {
              const pct = assigneeTotal > 0 ? Math.round((r.count / assigneeTotal) * 100) : 0
              const avg = r.avgHours != null ? t('requests.stats.pdfHours', { h: r.avgHours }) : '—'
              return `<tr><td>${escapeHtml(r.name)}</td><td class="num">${r.count}</td><td class="num">${pct}%</td><td class="num">${r.done}</td><td class="num">${r.active}</td><td class="num">${escapeHtml(avg)}</td></tr>`
            })
            .join('')}</tbody>
        </table>
      </section>`
          : ''
      const distGrid = [statusDonut, priorityDonut, categoryDonut, requesterDonut].filter(Boolean)
      const distHtml = distGrid.length
        ? `<section class="grid2">${distGrid.join('')}</section>`
        : `<p class="muted">${escapeHtml(t('requests.stats.noDataForPeriod'))}</p>`
      const chartHtml =
        execIncludeChart && chartImage
          ? `<div class="chart"><img src="${chartImage}" alt=""/></div>`
          : `<p class="muted">${escapeHtml(t('requests.stats.pdfChartMissing'))}</p>`
      const narrativeHtml =
        execIncludeNarrative && statsKpi.total > 0
          ? `<ul class="narrative">${narrative.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
          : ''
      const audienceLine = execReportAudience.trim() ? escapeHtml(execReportAudience.trim()) : ''
      const authorLine = execReportAuthor.trim()
        ? `${escapeHtml(t('requests.stats.pdfPrepared'))}: ${escapeHtml(execReportAuthor.trim())}`
        : ''
      const openN = statsRows.filter((r) => r.status === 'open').length
      const progN = statsRows.filter((r) => r.status === 'in_progress').length
      const highN = statsRows.filter((r) => r.priority === 'high').length
      const highRate = statsKpi.total > 0 ? Math.round((highN / statsKpi.total) * 100) : 0
      const fromMs = statsFrom.trim() ? Date.parse(`${statsFrom.trim()}T00:00:00`) : NaN
      const toMs = statsTo.trim() ? Date.parse(`${statsTo.trim()}T00:00:00`) : Date.now()
      const daySpan = Number.isFinite(fromMs)
        ? Math.max(1, Math.round((toMs - fromMs) / 86_400_000) + 1)
        : Math.max(1, statsSeries.items.length || 1)
      const perDay = (statsKpi.total / daySpan).toFixed(1)
      const topCat = categoryTop.find((i) => i.count > 0)
      const topAsg = assigneeTop.find((i) => i.count > 0)
      const asgShare = topAsg && assigneeTotal > 0 ? Math.round((topAsg.count / assigneeTotal) * 100) : 0

      const html = `<!doctype html>
<html lang="${locale === 'en' ? 'en' : 'ru'}">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page { size: A4 portrait; margin: 12mm 12mm 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; font-family: "Segoe UI", Inter, Arial, sans-serif; color: #0f172a; background: #fff; }
      .sheet { min-height: 262mm; page-break-after: always; break-after: page; padding-bottom: 8mm; }
      .sheet:last-child { page-break-after: auto; break-after: auto; }
      .cover { background: #0f172a; color: #f8fafc; padding: 22px 24px 20px; border-radius: 10px; }
      .cover-top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
      .brand-mark { font-size: 12px; letter-spacing: 0.38em; font-weight: 700; }
      .cover-date { font-size: 11px; color: #94a3b8; }
      .cover h1 { margin: 14px 0 0; font-size: 26px; font-weight: 650; letter-spacing: -0.03em; line-height: 1.15; color: #fff; }
      .kind { margin: 6px 0 0; font-size: 12px; color: #93c5fd; letter-spacing: 0.04em; }
      .dates { margin: 14px 0 0; font-size: 16px; font-weight: 600; letter-spacing: -0.02em; }
      .meta { margin: 8px 0 0; font-size: 11.5px; color: #cbd5e1; line-height: 1.55; }
      .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 16px; }
      .kpi { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; }
      .kpi .value { font-size: 22px; font-weight: 650; letter-spacing: -0.04em; line-height: 1; }
      .kpi .label { margin-top: 5px; font-size: 10.5px; color: #64748b; }
      .kpi .sub { margin-top: 2px; font-size: 10px; color: #94a3b8; }
      .page-title { margin: 0 0 14px; font-size: 13px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #1e3a5f; }
      .sec h2, .chart-card h2 { margin: 0 0 10px; font-size: 12.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #1e3a5f; }
      .narrative { margin: 14px 0 0; padding: 0; list-style: none; font-size: 12.5px; line-height: 1.65; color: #334155; }
      .narrative li + li { margin-top: 4px; }
      .chart img { width: 100%; height: auto; display: block; border: 1px solid #e2e8f0; border-radius: 8px; }
      .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
      .chart-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 12px 10px; page-break-inside: avoid; }
      .donut-row { display: flex; align-items: center; gap: 12px; }
      .legend { flex: 1; min-width: 0; }
      .leg { display: flex; align-items: center; gap: 6px; font-size: 11px; margin: 0 0 5px; }
      .dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
      .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .nmr { color: #64748b; white-space: nowrap; }
      .row { margin: 0 0 8px; }
      .row-top { display: flex; justify-content: space-between; gap: 12px; font-size: 11.5px; }
      .row-top span:last-child { color: #64748b; white-space: nowrap; }
      .bar { margin-top: 4px; height: 6px; background: #f1f5f9; border-radius: 99px; overflow: hidden; }
      .bar i { display: block; height: 100%; border-radius: 99px; }
      .tbl { width: 100%; border-collapse: collapse; font-size: 11px; }
      .tbl th { text-align: left; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: #64748b; border-bottom: 1.5px solid #0f172a; padding: 6px 8px; }
      .tbl td { border-bottom: 1px solid #e2e8f0; padding: 7px 8px; }
      .tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .muted { color: #64748b; font-size: 12px; }
      .foot { margin-top: 22px; font-size: 10px; color: #94a3b8; letter-spacing: 0.22em; text-transform: uppercase; }
    </style>
  </head>
  <body>
    <section class="sheet">
      <header class="cover">
        <div class="cover-top">
          <div class="brand-mark">CORAX</div>
          <div class="cover-date">${escapeHtml(nowText)}</div>
        </div>
        <h1>${escapeHtml(title)}</h1>
        <p class="kind">${escapeHtml(t('requests.stats.pdfKind'))}</p>
        <div class="dates">${escapeHtml(periodPretty)}</div>
        <div class="meta">
          ${escapeHtml(t('requests.stats.basis'))}: ${escapeHtml(basisText)}
          · ${escapeHtml(t('requests.stats.grouping'))}: ${escapeHtml(groupText)}
          ${audienceLine ? `<br/>${audienceLine}` : ''}
          ${authorLine ? `<br/>${authorLine}` : ''}
        </div>
      </header>
      <div class="kpis">
        <div class="kpi"><div class="value">${statsKpi.total}</div><div class="label">${escapeHtml(t('requests.stats.inPeriod'))}</div></div>
        <div class="kpi"><div class="value">${statsKpi.done}</div><div class="label">${escapeHtml(t('requests.stats.done'))}</div><div class="sub">${escapeHtml(t('requests.stats.pdfOfAll', { pct: statsKpi.completionRate }))}</div></div>
        <div class="kpi"><div class="value">${statsKpi.cancelled}</div><div class="label">${escapeHtml(t('requests.stats.cancelled'))}</div></div>
        <div class="kpi"><div class="value">${statsKpi.active}</div><div class="label">${escapeHtml(t('requests.stats.active'))}</div></div>
        <div class="kpi"><div class="value">${statsKpi.overdue}</div><div class="label">${escapeHtml(t('requests.stats.overdue'))}</div><div class="sub">${escapeHtml(t('requests.stats.pdfOfAll', { pct: statsKpi.overdueRate }))}</div></div>
        <div class="kpi"><div class="value">${escapeHtml(avgText)}</div><div class="label">${escapeHtml(t('requests.stats.avgClose'))}</div></div>
        <div class="kpi"><div class="value">${statsKpi.slaHitRate}%</div><div class="label">${escapeHtml(t('requests.stats.slaHit'))}</div></div>
        <div class="kpi"><div class="value">${escapeHtml(perDay)}</div><div class="label">${escapeHtml(t('requests.stats.pdfTicketsPerDay'))}</div></div>
      </div>
      ${narrativeHtml}
    </section>
    <section class="sheet">
      <h2 class="page-title">${escapeHtml(t('requests.stats.pdfPageKpi'))}</h2>
      <table class="tbl">
        <thead><tr><th>${escapeHtml(t('requests.stats.pdfBusinessLead'))}</th><th class="num">${escapeHtml(t('requests.stats.pdfColCount'))}</th></tr></thead>
        <tbody>
          <tr><td>${escapeHtml(t('requests.stats.pdfDaysInPeriod'))}</td><td class="num">${daySpan}</td></tr>
          <tr><td>${escapeHtml(t('requests.stats.pdfOpenCount'))}</td><td class="num">${openN}</td></tr>
          <tr><td>${escapeHtml(t('requests.stats.pdfInProgressCount'))}</td><td class="num">${progN}</td></tr>
          <tr><td>${escapeHtml(t('requests.stats.pdfHighPriority'))}</td><td class="num">${highN} · ${highRate}%</td></tr>
          <tr><td>${escapeHtml(t('requests.stats.pdfTopCategory'))}</td><td class="num">${escapeHtml(topCat ? `${topCat.name} (${topCat.count})` : '—')}</td></tr>
          <tr><td>${escapeHtml(t('requests.stats.pdfTopAssignee'))}</td><td class="num">${escapeHtml(topAsg ? topAsg.name : '—')}</td></tr>
          <tr><td>${escapeHtml(t('requests.stats.pdfConcentration'))}</td><td class="num">${asgShare}%</td></tr>
        </tbody>
      </table>
      ${statusDonut || priorityDonut ? `<div class="grid2" style="margin-top:18px">${statusDonut}${priorityDonut}</div>` : ''}
    </section>
    <section class="sheet">
      <h2 class="page-title">${escapeHtml(t('requests.stats.pdfPageDynamics'))}</h2>
      ${chartHtml}
    </section>
    <section class="sheet">
      <h2 class="page-title">${escapeHtml(t('requests.stats.pdfPageMix'))}</h2>
      ${execIncludeDistributions ? distHtml : `<p class="muted">${escapeHtml(t('requests.stats.includeDistributions'))}</p>`}
    </section>
    <section class="sheet">
      <h2 class="page-title">${escapeHtml(t('requests.stats.pdfPagePeople'))}</h2>
      ${assigneeBars ? `<section class="sec">${assigneeBars}</section>` : ''}
      ${assigneeTable}
      <div class="foot">Corax</div>
    </section>
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
      const returnPage = editingReturnPage
      setTitle('')
      setDescription('')
      resetCreateFormAfterSubmit()
      toast.ok(t('requests.messages.deleted'))
      await load()
      void refreshSummary()
      if (returnPath && returnPath !== '/requests') navigateBackToList(returnPath, returnPage)
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
    const closeVal = closed || planned
    setPlannedCloseLocal(planned)
    setClosedAtLocal(closeVal)
    setClosedSameAsPlanned(!closed || !planned || closed === planned)
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
      <div>
        <section className="min-w-0">
          {/* Создание / редактирование — стиль как у Сети, sticky save */}
          {tab === 'create' ? (
            <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
              <form onSubmit={onSubmitRequest} className="flex flex-col gap-4">
                <div className="sticky top-0 z-30 -mx-1 flex flex-col gap-3 rounded-xl border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-surface)_92%,transparent)] px-3 py-3 shadow-sm backdrop-blur-md sm:flex-row sm:items-center sm:justify-between sm:px-4">
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-semibold tracking-tight text-[var(--color-fg)] sm:text-lg">
                      {editingRequestId != null
                        ? t('requests.create.editTitle', { id: editingRequestId })
                        : t('requests.create.newTitle')}
                    </h2>
                    <p className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)] sm:text-sm">
                      {editingRequestId != null
                        ? t('requests.create.editSubtitle')
                        : t('requests.create.newSubtitle')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {editingRequestId != null ? (
                      <button
                        type="button"
                        disabled={saving || editDeleting}
                        onClick={cancelEditing}
                        className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                      >
                        {t('requests.create.cancel')}
                      </button>
                    ) : null}
                    {editingRequestId != null && canManageRequests ? (
                      editDeleteConfirm ? (
                        <>
                          <button
                            type="button"
                            disabled={editDeleting}
                            onClick={() => void removeEditingRequest()}
                            className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-800 hover:bg-red-100 disabled:opacity-50 dark:bg-red-500/15 dark:text-red-200"
                          >
                            {editDeleting ? t('requests.create.deleting') : t('requests.create.deleteYes')}
                          </button>
                          <button
                            type="button"
                            disabled={editDeleting}
                            onClick={() => setEditDeleteConfirm(false)}
                            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                          >
                            {t('requests.create.cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          disabled={saving || editDeleting}
                          onClick={() => setEditDeleteConfirm(true)}
                          className="rounded-lg border border-red-300/80 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-500/10"
                        >
                          {t('requests.create.deleteRequest')}
                        </button>
                      )
                    ) : null}
                    <button
                      type="submit"
                      disabled={saving || editDeleting}
                      className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                    >
                      {saving
                        ? editingRequestId != null
                          ? t('requests.create.saving')
                          : t('requests.create.creating')
                        : editingRequestId != null
                          ? t('requests.create.saveChanges')
                          : t('requests.create.createRequest')}
                    </button>
                  </div>
                </div>

                {!summaryLoading && summary ? (
                  <div className="flex flex-wrap gap-3 text-sm">
                    <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
                      {t('requests.create.total')}: <strong>{summary.service_requests_total}</strong>
                    </span>
                    <span className="rounded-lg bg-sky-500/10 px-3 py-1.5 text-sky-900 dark:text-sky-200">
                      {t('requests.create.active')}: <strong>{summary.service_requests_active}</strong>
                    </span>
                  </div>
                ) : null}

                {editDeleteConfirm && editingRequestId != null ? (
                  <div className="rounded-xl border border-red-300/50 bg-red-50/80 px-4 py-3 text-sm text-red-950 dark:bg-red-500/10 dark:text-red-100">
                    {t('requests.create.deleteConfirm', { title })}
                  </div>
                ) : null}

                <div className="grid gap-4 lg:grid-cols-12">
                  <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-8 sm:p-5">
                    {editingRequestId == null ? (
                      <div className="flex flex-wrap items-end gap-2">
                        <label className="min-w-[12rem] flex-1">
                          <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.template')}</span>
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
                            className={CREATE_FORM_INPUT_CLS}
                          >
                            <option value="">{t('requests.create.chooseTemplate')}</option>
                            {tplRows.map((tpl) => (
                              <option key={tpl.id} value={String(tpl.id)}>
                                {tpl.title}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          onClick={() => navigate('/requests/templates')}
                          className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                        >
                          {tplRows.length === 0 ? t('requests.create.noTemplates') : t('requests.create.manageTemplates')}
                        </button>
                      </div>
                    ) : null}

                    <label className="block">
                      <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.title')}</span>
                      {recentTitles.length > 0 ? (
                        <div className="mb-2 flex flex-wrap gap-1.5">
                          {recentTitles.map((rt) => (
                            <span
                              key={rt}
                              className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-[var(--color-bg-muted)] pl-2.5"
                            >
                              <button
                                type="button"
                                className="max-w-[min(14rem,70vw)] truncate py-1 text-left text-xs font-medium"
                                onClick={() => setTitle(rt)}
                                title={rt}
                              >
                                {rt}
                              </button>
                              <button
                                type="button"
                                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface)]"
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
                        onKeyDown={(e) => {
                          if (e.key === 'Tab' && !e.shiftKey && aiTitleSuggestion && aiTitleSuggestion !== title) {
                            e.preventDefault()
                            setTitle(aiTitleSuggestion)
                            setAiTitleSuggestion('')
                          }
                        }}
                        required
                        className={CREATE_FORM_INPUT_CLS}
                      />
                      {aiTitleSuggestion && aiTitleSuggestion.trim() !== title.trim() ? (
                        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 px-3 py-2 text-sm">
                          <span className="text-[var(--color-fg-muted)]">CORAX AI:</span>
                          <span className="font-medium">{aiTitleSuggestion}</span>
                          <button
                            type="button"
                            className="rounded-md bg-[var(--color-primary)] px-2.5 py-1 text-xs font-semibold text-white"
                            onClick={() => {
                              setTitle(aiTitleSuggestion)
                              setAiTitleSuggestion('')
                            }}
                          >
                            Применить
                          </button>
                          <button type="button" className="text-xs text-[var(--color-fg-subtle)] hover:underline" onClick={() => setAiTitleSuggestion('')}>
                            Скрыть
                          </button>
                          <span className="text-[11px] text-[var(--color-fg-subtle)]">Tab</span>
                        </div>
                      ) : null}
                      {editingRequestId != null ? (
                        <button
                          type="button"
                          disabled={aiSuggestBusy}
                          className="mt-2 text-xs font-medium text-[var(--color-primary)] hover:underline disabled:opacity-50"
                          onClick={async () => {
                            if (editingRequestId == null) return
                            setAiSuggestBusy(true)
                            try {
                              const out = await api.suggestServiceRequestAi(editingRequestId)
                              if (out.category) setCategory(out.category)
                              if (out.title_suggestion) setAiTitleSuggestion(out.title_suggestion)
                              if (!out.ok && out.error_detail) toast.error(out.error_detail)
                              else toast.ok('CORAX AI обновил подсказки')
                            } catch (err) {
                              toast.error(err instanceof Error ? err.message : String(err))
                            } finally {
                              setAiSuggestBusy(false)
                            }
                          }}
                        >
                          {aiSuggestBusy ? 'CORAX AI…' : 'Пересчитать CORAX AI'}
                        </button>
                      ) : null}
                    </label>

                    {!showDescription ? (
                      <button
                        type="button"
                        className="self-start text-xs font-medium text-[var(--color-primary)] hover:underline"
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
                          rows={3}
                          className={`${CREATE_FORM_INPUT_CLS} resize-y`}
                        />
                      </label>
                    )}

                    <div className="grid gap-3 sm:grid-cols-2">
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

                    <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
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

                    {createFormAssignees.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {createFormAssignees.map((u) => (
                          <span
                            key={u.id}
                            className="inline-flex max-w-full items-center gap-1 rounded-full bg-[var(--color-bg-muted)] px-2.5 py-1 text-xs font-medium"
                          >
                            <span className="truncate">{userDirectoryLabel(u)}</span>
                            <button
                              type="button"
                              className="shrink-0 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                              onClick={() => setAssigneeIds((ids) => ids.filter((id) => id !== u.id))}
                              aria-label={t('requests.assigneesPicker.remove', { name: userDirectoryLabel(u) })}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-4 lg:col-span-4">
                    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-5">
                      <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">{t('requests.create.status')}</h3>
                      <div className="grid gap-3">
                        <label className="block">
                          <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.status')}</span>
                          <select
                            value={createStatus}
                            onChange={(e) => {
                              const next = e.target.value
                              if (!isRequestStatus(next)) return
                              setCreateStatus(next)
                              if (next === 'open') {
                                setPlannedCloseLocal('')
                                setClosedAtLocal('')
                                setClosedSameAsPlanned(true)
                              } else if (next === 'in_progress') {
                                setClosedAtLocal('')
                                setClosedSameAsPlanned(true)
                                if (!plannedCloseLocal.trim()) {
                                  setPlannedCloseLocal(defaultPlannedCloseLocal())
                                }
                              } else if (next === 'done' || next === 'cancelled') {
                                const closeVal =
                                  plannedCloseLocal.trim() || closedAtLocal.trim() || defaultOpenedLocal()
                                setClosedSameAsPlanned(true)
                                setPlannedCloseLocal(closeVal)
                                setClosedAtLocal(closeVal)
                              }
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
                            className={CREATE_FORM_INPUT_CLS}
                          >
                            {REQUEST_PRIORITIES.map((p) => (
                              <option key={p} value={p}>
                                {requestPriorityLabel(p)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.openedAt')}</span>
                          <input
                            type="datetime-local"
                            value={openedAtLocal}
                            onChange={(e) => setOpenedAtLocal(e.target.value)}
                            required
                            className={CREATE_FORM_INPUT_CLS}
                          />
                        </label>
                        {createStatus !== 'open' ? (
                          <label className="block">
                            <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.plannedCloseAt')}</span>
                            <input
                              type="datetime-local"
                              value={plannedCloseLocal}
                              onChange={(e) => setPlannedCloseLocal(e.target.value)}
                              className={CREATE_FORM_INPUT_CLS}
                            />
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {DURATION_PRESETS_MIN.map((preset) => (
                                <button
                                  key={`plan-${preset.minutes}`}
                                  type="button"
                                  className="rounded-full bg-[var(--color-bg-muted)] px-2.5 py-0.5 text-[11px] font-medium hover:bg-[var(--color-surface)]"
                                  title={t('requests.durations.fromOpenedTitle', {
                                    label: durationPresetLabel(preset.minutes),
                                  })}
                                  onClick={() => {
                                    const v = addMinutesToLocalDatetimeValue(openedAtLocal, preset.minutes)
                                    if (v) setPlannedCloseLocal(v)
                                  }}
                                >
                                  +{durationPresetLabel(preset.minutes)}
                                </button>
                              ))}
                              <button
                                type="button"
                                className="rounded-full bg-[var(--color-bg-muted)] px-2.5 py-0.5 text-[11px] font-medium"
                                onClick={() => setPlannedCloseLocal('')}
                              >
                                {t('requests.categoryPicker.reset')}
                              </button>
                            </div>
                          </label>
                        ) : null}
                        {createStatus === 'done' || createStatus === 'cancelled' ? (
                          <>
                            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/50 px-3 py-2">
                              <input
                                type="checkbox"
                                className="rounded border-[var(--color-border)]"
                                checked={closedSameAsPlanned}
                                onChange={(e) => {
                                  const on = e.target.checked
                                  setClosedSameAsPlanned(on)
                                  if (on) setClosedAtLocal(plannedCloseLocal)
                                }}
                              />
                              <span className="text-xs text-[var(--color-fg)]">{t('requests.create.closedSameAsPlanned')}</span>
                            </label>
                            {!closedSameAsPlanned ? (
                              <label className="block">
                                <span className={CREATE_FORM_LABEL_CLS}>{t('requests.create.closedAt')}</span>
                                <input
                                  type="datetime-local"
                                  value={closedAtLocal}
                                  onChange={(e) => setClosedAtLocal(e.target.value)}
                                  required
                                  className={CREATE_FORM_INPUT_CLS}
                                />
                              </label>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-fg-muted)] shadow-sm">
                      {t('requests.create.warehouseActionHint')}{' '}
                      <a href="/warehouse" className="font-medium text-[var(--color-primary)] hover:underline">
                        {t('requests.create.warehouseLink')}
                      </a>
                    </div>
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
                      : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] ring-1 ring-slate-200 hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {tab.label}
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => {
                setDbShowAll((v) => !v)
                setDbPage(1)
              }}
              className="rounded-full bg-[var(--color-surface)] px-3.5 py-1.5 text-xs font-semibold text-[var(--color-fg-muted)] ring-1 ring-slate-200 transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
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
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm text-[var(--color-fg)] shadow-sm placeholder:text-[var(--color-fg-subtle)]"
              />
              <div className="mt-1 text-[11px] font-medium text-[var(--color-fg-muted)]">
                {t('requests.database.searchHint')}
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:min-w-[22rem]">
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-semibold text-[var(--color-fg)] shadow-sm"
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
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-semibold text-[var(--color-fg)] shadow-sm"
                  aria-label={t('requests.database.sortAria')}
                >
                  <option value="id_desc">{t('requests.database.sort.idDesc')}</option>
                  <option value="id_asc">{t('requests.database.sort.idAsc')}</option>
                  <option value="opened_desc">{t('requests.database.sort.openedDesc')}</option>
                  <option value="closed_desc">{t('requests.database.sort.closedDesc')}</option>
                  <option value="priority_desc">{t('requests.database.sort.priorityDesc')}</option>
                </select>
                <select
                  value={dbPageSize}
                  onChange={(e) => {
                    const next = Number(e.target.value) as (typeof DB_PAGE_SIZE_OPTIONS)[number]
                    setDbPageSize(next)
                    setDbPage(1)
                    try {
                      localStorage.setItem(DB_PAGE_SIZE_KEY, String(next))
                    } catch {
                      /* Ignore unavailable local storage. */
                    }
                  }}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-semibold text-[var(--color-fg)] shadow-sm"
                  aria-label={t('requests.database.pageSizeAria')}
                >
                  {DB_PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {t('requests.database.pageSize', { size })}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={pdfBusy}
                  onClick={() => void downloadPdf()}
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-xs font-semibold text-[var(--color-fg)] shadow-sm transition hover:bg-[var(--color-surface-muted)] disabled:opacity-50"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-600" aria-hidden />
                  {pdfBusy ? 'PDF…' : 'PDF'}
                </button>
              </div>

              <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setReportOpen(true)}
                className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-xs font-semibold text-[var(--color-fg)] shadow-sm transition hover:bg-[var(--color-surface-muted)]"
                title={t('requests.database.reportTitle')}
              >
                {t('requests.database.reportButton')}
              </button>
              {canManageRequests ? (
                <details className="relative">
                  <summary className="cursor-pointer list-none rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2.5 text-xs font-semibold text-[var(--color-fg)] shadow-sm transition hover:bg-[var(--color-surface-muted)] marker:content-none [&::-webkit-details-marker]:hidden">
                    {t('requests.database.actions')}
                  </summary>
                  <div className="absolute right-0 z-20 mt-1 w-72 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg">
                    <button
                      type="button"
                      disabled={alignDatesBusy || loading}
                      onClick={() => void alignPlannedToClosedDates()}
                      className="w-full rounded-lg px-3 py-2 text-left text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                      title={t('requests.database.alignDatesTitle')}
                    >
                      {alignDatesBusy ? t('requests.database.alignDatesBusy') : t('requests.database.alignDates')}
                    </button>
                  </div>
                </details>
              ) : null}
              </div>
            </div>
          </div>

          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">
            {t('requests.database.list')}
            {!loading ? (
              <span className="ml-2 font-normal text-[var(--color-fg-muted)]">· {visibleRows.length}{visibleRows.length !== total ? ` из ${total}` : ''}</span>
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
                <div className="w-full max-w-4xl overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl">
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-3">
                    <div>
                      <div className="text-xs font-bold uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">{t('requests.database.reportHeader')}</div>
                      <div className="text-sm font-semibold text-[var(--color-fg)]">
                        {t('requests.database.reportForCurrentList', {
                          visible: visibleRows.length,
                          suffix: visibleRows.length !== total ? ` / ${total}` : '',
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
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
                      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">{t('requests.database.total')}</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-[var(--color-fg)]">
                          {visibleRows.length}
                        </div>
                        <div className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('requests.database.totalSub')}</div>
                      </div>
                      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">{t('requests.database.closed')}</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-[var(--color-fg)]">
                          {visibleRows.filter((r) => r.status === 'done').length}
                        </div>
                        <div className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('requests.database.closedSub')}</div>
                      </div>
                      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
                        <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">{t('requests.database.withDeadline')}</div>
                        <div className="mt-1 font-[family-name:var(--font-display)] text-3xl font-semibold tracking-tight text-[var(--color-fg)]">
                          {visibleRows.filter((r) => Boolean(r.planned_close_at)).length}
                        </div>
                        <div className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('requests.database.withDeadlineSub')}</div>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 lg:grid-cols-2">
                      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
                        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">{t('requests.database.byStatus')}</div>
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
                                    <span className="font-medium text-[var(--color-fg)]">{requestStatusLabel(x.k)}</span>
                                    <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                                      {x.v} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                                    <div
                                      className="h-full rounded-full bg-[var(--color-primary)]"
                                      style={{ width: `${Math.max(3, Math.round((x.v / max) * 100))}%` }}
                                    />
                                  </div>
                                </div>
                              )
                            })
                          })()}
                        </div>
                      </div>

                      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm">
                        <div className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-fg-muted)]">{t('requests.database.byPriority')}</div>
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
                                    <span className="font-medium text-[var(--color-fg)]">{requestPriorityLabel(x.k)}</span>
                                    <span className="font-mono text-xs font-semibold text-[var(--color-fg)]">
                                      {x.v} ({pct}%)
                                    </span>
                                  </div>
                                  <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                                    <div
                                      className="h-full rounded-full bg-[var(--color-primary)]"
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

                    <p className="mt-3 text-xs text-[var(--color-fg-muted)]">
                      {t('requests.database.browserPrintNote')}
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {loading ? (
              <p className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] py-14 text-center text-sm text-[var(--color-fg-muted)]">
                {t('requests.database.loading')}
              </p>
            ) : visibleRows.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)] py-14 text-center text-sm text-[var(--color-fg-muted)]">
                {query.trim()
                  ? t('requests.database.noSearchResults')
                  : filterStatus
                    ? t('requests.database.noItemsInFilter')
                    : t('requests.database.empty')}
              </p>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm ring-1 ring-slate-200/25">
                <div className="overflow-x-auto">
                  <table className="min-w-[980px] w-full max-sm:min-w-[36rem] border-collapse text-left text-sm">
                    <thead className="sticky top-0 z-10 bg-[var(--color-surface-muted)]">
                      <tr className="border-b border-[var(--color-border)] text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-muted)]">
                        <th
                          className="app-table-sticky-col cursor-pointer px-3 py-2.5"
                          onClick={() => setSortKey((prev) => (prev === 'id_asc' ? 'id_desc' : 'id_asc'))}
                          title={t('requests.database.table.sortById')}
                        >
                          ID{sortHint('id_asc', 'id_desc')}
                        </th>
                        <th className="px-3 py-2.5">{t('requests.database.table.title')}</th>
                        <th className="app-hide-xs px-3 py-2.5">{t('requests.database.table.requester')}</th>
                        <th className="app-hide-xs cursor-pointer px-3 py-2.5" onClick={() => setSortKey('opened_desc')} title={t('requests.database.table.sortByOpened')}>
                          {t('requests.database.table.openedAt')}{sortHint('opened_desc')}
                        </th>
                        <th className="app-hide-xs cursor-pointer px-3 py-2.5" onClick={() => setSortKey('closed_desc')} title={t('requests.database.table.sortByClosed')}>
                          {t('requests.database.table.closedAt')}{sortHint('closed_desc')}
                        </th>
                        <th className="px-3 py-2.5">{t('requests.database.table.status')}</th>
                        <th className="cursor-pointer px-3 py-2.5" onClick={() => setSortKey('priority_desc')} title={t('requests.database.table.sortByPriority')}>
                          {t('requests.database.table.priority')}{sortHint('priority_desc')}
                        </th>
                        <th className="app-hide-xs px-3 py-2.5">{t('requests.database.table.category')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {dbRowsToRender.map((row) => (
                        <tr
                          key={row.id}
                          data-request-id={row.id}
                          className="border-b border-[var(--color-border)]/80 bg-[var(--color-surface)] align-top transition hover:bg-[var(--color-surface-muted)]"
                          onClick={() => openRequestForEdit(row)}
                          role="button"
                          title={t('requests.database.table.editTitle')}
                        >
                              <td className="app-table-sticky-col whitespace-nowrap px-3 py-3 font-mono text-xs font-semibold text-[var(--color-fg)]">
                                <button
                                  type="button"
                                  className="rounded-md px-1.5 py-1 text-left hover:bg-[var(--color-surface-muted)]"
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
                                    <div className="break-words font-semibold leading-5 text-[var(--color-fg)]" title={row.title}>
                                      <span className="mr-2">{row.title}</span>
                                      {row.location ? (
                                        <span className="inline font-normal text-sm text-[var(--color-fg-muted)]" title={row.location}>
                                          · {row.location}
                                        </span>
                                      ) : null}
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
                                      <div className="mt-0.5 truncate text-xs text-[var(--color-fg-muted)]" title={row.computer_hostname}>
                                        {t('requests.database.table.pc', { name: row.computer_hostname })}
                                      </div>
                                    ) : null}
                                  </div>
                                </div>
                              </td>
                              <td className="app-hide-xs px-3 py-3 text-xs text-[var(--color-fg)]">
                                <span className="line-clamp-2">{row.requester_name || '—'}</span>
                              </td>
                              <td className="app-hide-xs whitespace-nowrap px-3 py-3 text-xs text-[var(--color-fg-muted)]">
                                <span className="font-medium text-[var(--color-fg)]">{fmtRuShortDateTime(row.opened_at ?? row.created_at, locale)}</span>
                              </td>
                              <td className="app-hide-xs whitespace-nowrap px-3 py-3 text-xs text-[var(--color-fg-muted)]">
                                <span className="font-medium text-[var(--color-fg)]">
                                  {fmtRuShortDateTime(row.closed_at ?? row.planned_close_at, locale)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs">
                                <span
                                  className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                    STATUS_PILL[row.status] ?? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] ring-1 ring-slate-200'
                                  }`}
                                >
                                  {requestStatusLabel(row.status)}
                                </span>
                              </td>
                              <td className="whitespace-nowrap px-3 py-3 text-xs text-[var(--color-fg)]">
                                {requestPriorityLabel(row.priority)}
                              </td>
                              <td className="app-hide-xs px-3 py-3 text-xs text-[var(--color-fg)]">
                                <span className="line-clamp-2">{row.category || '—'}</span>
                              </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {!loading && !dbShowAll && (query.trim() || filterCategory.trim() || sortKey !== 'id_desc' ? visibleRows.length : total) > dbPageSize ? (
              <div className="mt-3 flex flex-col gap-2 text-sm text-[var(--color-fg-muted)] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span>
                  {t('requests.database.pagination.shown', {
                    shown: dbRowsToRender.length,
                    total: query.trim() || filterCategory.trim() || sortKey !== 'id_desc' ? visibleRows.length : total,
                  })}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-40 sm:min-h-0"
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
                    className="min-h-11 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-semibold text-[var(--color-fg)] transition hover:bg-[var(--color-surface-muted)] disabled:opacity-40 sm:min-h-0"
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

        {/* Статистика — vibe как у вкладки Сеть */}
        {tab === 'stats' ? (
          <div className="mx-auto flex w-full min-w-0 flex-col gap-4 lg:col-span-12">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between print:hidden">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">{t('requests.stats.title')}</h2>
                <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
                  {t('requests.stats.loadedHint', { count: rows.length })} · {statsPeriodLabel}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadExecutivePdf()}
                  className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white"
                  title={t('requests.stats.presentationPdfTitle')}
                >
                  {t('requests.stats.presentationPdf')}
                </button>
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
                >
                  {t('requests.database.printPdf')}
                </button>
                <button
                  type="button"
                  onClick={() => void downloadPdf()}
                  className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)]"
                  title={t('requests.stats.tablePdfTitle')}
                >
                  {t('requests.stats.tablePdf')}
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              {(
                [
                  [t('requests.stats.inPeriod'), String(statsRows.length), ''],
                  [t('requests.stats.done'), String(statsKpi.done), `${statsKpi.completionRate}%`],
                  [t('requests.stats.cancelled'), String(statsKpi.cancelled), ''],
                  [t('requests.stats.active'), String(statsKpi.active), ''],
                  [t('requests.stats.overdue'), String(statsKpi.overdue), `${statsKpi.overdueRate}%`],
                  [
                    t('requests.stats.avgClose'),
                    statsKpi.avgCloseHours != null ? t('requests.stats.pdfHours', { h: statsKpi.avgCloseHours }) : '—',
                    '',
                  ],
                  [t('requests.stats.slaHit'), `${statsKpi.slaHitRate}%`, ''],
                ] as const
              ).map(([label, value, sub]) => (
                <div
                  key={label}
                  className="min-w-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3 shadow-sm"
                >
                  <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">{label}</div>
                  <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-[var(--color-fg)]">
                    {value}
                    {sub ? <span className="ml-1.5 text-xs font-normal text-[var(--color-fg-subtle)]">{sub}</span> : null}
                  </div>
                </div>
              ))}
            </div>

            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 print:hidden sm:p-5">
              <div className="grid gap-6 xl:grid-cols-2">
                <div>
              <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                {t('requests.stats.filters')}
              </div>
              <div className="grid gap-4 lg:grid-cols-12">
                <label className="block lg:col-span-4">
                  <span className="mb-1.5 block text-xs text-[var(--color-fg-muted)]">{t('requests.stats.period')}</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={statsFrom}
                      onChange={(e) => setStatsFrom(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                      title={t('requests.stats.from')}
                    />
                    <span className="text-[var(--color-fg-subtle)]">—</span>
                    <input
                      type="date"
                      value={statsTo}
                      onChange={(e) => setStatsTo(e.target.value)}
                      className="min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                      title={t('requests.stats.to')}
                    />
                  </div>
                </label>
                <div className="lg:col-span-4">
                  <div className="mb-1.5 text-xs text-[var(--color-fg-muted)]">{t('requests.stats.basis')}</div>
                  <div className="flex rounded-lg bg-[var(--color-bg-muted)] p-0.5">
                    {(
                      [
                        ['opened', t('requests.stats.basisOpened')],
                        ['last_change', t('requests.stats.basisLastChange')],
                        ['closed', t('requests.stats.basisClosed')],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setStatsBasis(id)}
                        className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-xs font-medium transition ${
                          statsBasis === id
                            ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                            : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="lg:col-span-4">
                  <div className="mb-1.5 text-xs text-[var(--color-fg-muted)]">{t('requests.stats.grouping')}</div>
                  <div className="flex rounded-lg bg-[var(--color-bg-muted)] p-0.5">
                    {(
                      [
                        ['day', t('requests.stats.groupDay')],
                        ['week', t('requests.stats.groupWeek')],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setStatsGroup(id)}
                        className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-xs font-medium transition ${
                          statsGroup === id
                            ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                            : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="lg:col-span-4">
                  <div className="mb-1.5 text-xs text-[var(--color-fg-muted)]">{t('requests.stats.chart')}</div>
                  <div className="flex rounded-lg bg-[var(--color-bg-muted)] p-0.5">
                    {(
                      [
                        ['total', t('requests.stats.chartTotal')],
                        ['status', t('requests.stats.chartStatus')],
                      ] as const
                    ).map(([id, label]) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => setStatsChartMode(id)}
                        className={`min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-xs font-medium transition ${
                          statsChartMode === id
                            ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                            : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex flex-wrap items-end gap-2 lg:col-span-12">
                  <button
                    type="button"
                    onClick={() => setStatsOnlyWithPlanned((v) => !v)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      statsOnlyWithPlanned
                        ? 'bg-[var(--color-fg)] text-[var(--color-surface)]'
                        : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    {t('requests.stats.onlyWithDeadline')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStatsOnlyOverdue((v) => !v)}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      statsOnlyOverdue
                        ? 'bg-[var(--color-fg)] text-[var(--color-surface)]'
                        : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                    }`}
                  >
                    {t('requests.stats.overdueOnly')}
                  </button>
                  <label className="ml-auto flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                    {t('requests.stats.topN')}
                    <select
                      value={String(statsTopN)}
                      onChange={(e) => setStatsTopN(Math.max(5, Math.min(15, Number(e.target.value) || 8)))}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                    >
                      <option value="6">6</option>
                      <option value="8">8</option>
                      <option value="10">10</option>
                      <option value="12">12</option>
                      <option value="15">15</option>
                    </select>
                  </label>
                </div>
              </div>
                </div>
                <div>
                  <div className="mb-4 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                    {t('requests.stats.pdfOptions')}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block text-sm sm:col-span-2">
                      <span className="mb-1 block text-xs text-[var(--color-fg-subtle)]">{t('requests.stats.reportName')}</span>
                      <input type="text" value={execReportTitle} onChange={(e) => setExecReportTitle(e.target.value)} className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block text-xs text-[var(--color-fg-subtle)]">{t('requests.stats.audience')}</span>
                      <input type="text" value={execReportAudience} onChange={(e) => setExecReportAudience(e.target.value)} className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm" />
                    </label>
                    <label className="block text-sm">
                      <span className="mb-1 block text-xs text-[var(--color-fg-subtle)]">{t('requests.stats.author')}</span>
                      <input
                        type="text"
                        value={execReportAuthor}
                        onChange={(e) => setExecReportAuthor(e.target.value)}
                        placeholder={user?.full_name || user?.username || t('requests.stats.authorPlaceholder')}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2 sm:col-span-2">
                      {(
                        [
                          [execIncludeNarrative, setExecIncludeNarrative, t('requests.stats.includeNarrative')],
                          [execIncludeChart, setExecIncludeChart, t('requests.stats.includeChart')],
                          [execIncludeDistributions, setExecIncludeDistributions, t('requests.stats.includeDistributions')],
                          [execIncludeAssigneeLoad, setExecIncludeAssigneeLoad, t('requests.stats.includeAssigneeLoad')],
                        ] as const
                      ).map(([checked, setChecked, label], i) => (
                        <label key={i} className="inline-flex items-center gap-2 rounded-full bg-[var(--color-bg-muted)] px-3 py-1 text-xs text-[var(--color-fg)]">
                          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-12">
              {statsSeries.items.length > 0 ? (
              <div className="stats-report rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-12 sm:p-5">
                <h3 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">{t('requests.stats.dynamics')}</h3>
                <div className="h-[300px]">
                  <Suspense fallback={<div className="h-[300px]" aria-hidden />}>
                    <RequestsStatsLineChart data={statsLineChart.data} options={statsLineChart.options} />
                  </Suspense>
                </div>
              </div>
              ) : null}

              {statsStatusItems.some((i) => i.count > 0) ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-6 sm:p-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                    {t('requests.stats.byStatuses')}
                  </div>
                  <DonutDistribution
                    items={topNWithOther(statsStatusItems, 8, t('requests.statsData.otherStatuses'))}
                    emptyText={t('requests.charts.noData')}
                    compact
                  />
                </div>
              ) : null}

              {statsPriorityItems.some((i) => i.count > 0) ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-6 sm:p-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                    {t('requests.stats.byPriorities')}
                  </div>
                  <DonutDistribution
                    items={topNWithOther(statsPriorityItems, 8, t('requests.statsData.otherPriorities'))}
                    emptyText={t('requests.charts.noData')}
                    compact
                  />
                </div>
              ) : null}

              {statsCategoryItems.some((i) => i.count > 0) ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-6 sm:p-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                    {t('requests.stats.byCategoryTop')}
                  </div>
                  <DonutDistribution
                    items={topNWithOther(statsCategoryItems, statsTopN, t('requests.statsData.otherCategories'))}
                    emptyText={t('requests.stats.noCategories')}
                    compact
                  />
                </div>
              ) : null}

              {statsRequesterItems.some((i) => i.count > 0) ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-6 sm:p-5">
                  <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                    {t('requests.stats.byRequesterTop')}
                  </div>
                  <DonutDistribution
                    items={topNWithOther(statsRequesterItems, statsTopN, t('requests.statsData.otherUsers'))}
                    emptyText={t('requests.stats.noRequesters')}
                    compact
                  />
                </div>
              ) : null}

              {statsAssigneeItems.some((i) => i.count > 0) ? (
                <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm lg:col-span-5 sm:p-5">
                  <HorizontalBars
                    title={t('requests.stats.assigneeLoadTop')}
                    items={statsAssigneeItems.slice(0, Math.max(statsTopN, 12))}
                    total={Math.max(1, statsAssigneeItems.reduce((acc, r) => acc + r.count, 0))}
                  />
                </div>
              ) : null}

              {statsAssigneeDetail.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] lg:col-span-7">
                  <div className="border-b border-[var(--color-border)] px-4 py-3">
                    <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('requests.stats.assigneeBoard')}</h3>
                  </div>
                  <table className="min-w-full text-left text-sm">
                    <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                      <tr>
                        <th className="px-3 py-2.5">{t('requests.stats.assigneeName')}</th>
                        <th className="px-3 py-2.5 text-right">{t('requests.stats.assigneeTickets')}</th>
                        <th className="px-3 py-2.5 text-right">{t('requests.stats.assigneeShare')}</th>
                        <th className="px-3 py-2.5 text-right">{t('requests.stats.assigneeDone')}</th>
                        <th className="px-3 py-2.5 text-right">{t('requests.stats.assigneeActive')}</th>
                        <th className="px-3 py-2.5 text-right">{t('requests.stats.assigneeAvg')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statsAssigneeDetail.slice(0, 12).map((row) => {
                        const share = statsAssigneeLoadTotal > 0 ? Math.round((row.count / statsAssigneeLoadTotal) * 100) : 0
                        return (
                          <tr key={row.name} className="border-b border-[var(--color-border)]/70">
                            <td className="max-w-[180px] truncate px-3 py-2.5 font-medium" title={row.name}>
                              {row.name}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums">{row.count}</td>
                            <td className="px-3 py-2.5 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">{share}%</td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums">{row.done}</td>
                            <td className="px-3 py-2.5 text-right font-mono tabular-nums">{row.active}</td>
                            <td className="px-3 py-2.5 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
                              {row.avgHours != null ? t('requests.stats.pdfHours', { h: row.avgHours }) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}

              <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] lg:col-span-12">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
                  <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('requests.stats.requestsForPeriod')}</h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-[var(--color-fg-muted)]">
                      {statsRows.length} {requestPluralLabel(statsRows.length)}
                    </span>
                    <select
                      value={sortKey}
                      onChange={(e) => setSortKey(e.target.value as SortKey)}
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs print:hidden"
                    >
                      <option value="id_desc">{t('requests.stats.sortIdDesc')}</option>
                      <option value="id_asc">{t('requests.stats.sortIdAsc')}</option>
                      <option value="opened_desc">{t('requests.stats.sortOpenedDesc')}</option>
                      <option value="closed_desc">{t('requests.stats.sortClosedDesc')}</option>
                      <option value="priority_desc">{t('requests.stats.sortPriorityDesc')}</option>
                    </select>
                  </div>
                </div>
                {statsRows.length === 0 ? (
                  <p className="px-3 py-10 text-center text-sm text-[var(--color-fg-subtle)]">
                    {t('requests.stats.noRequestsForPeriod')}
                  </p>
                ) : (
                  <table className="min-w-full text-left text-sm">
                    <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
                      <tr>
                        <th className="px-3 py-2.5">ID</th>
                        <th className="px-3 py-2.5">{t('requests.database.table.title')}</th>
                        <th className="px-3 py-2.5">{t('requests.database.table.status')}</th>
                        <th className="app-hide-xs px-3 py-2.5">{t('requests.database.table.requester')}</th>
                        <th className="app-hide-xs px-3 py-2.5">{t('requests.database.table.openedAt')}</th>
                        <th className="app-hide-xs px-3 py-2.5">{t('requests.database.table.closedAt')}</th>
                        <th className="px-3 py-2.5">{t('requests.database.table.priority')}</th>
                        <th className="app-hide-xs px-3 py-2.5">{t('requests.database.table.category')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statsRows.map((row) => (
                        <tr
                          key={row.id}
                          data-request-id={row.id}
                          className="cursor-pointer border-b border-[var(--color-border)]/70 hover:bg-[var(--color-bg-muted)]/50"
                          onClick={() => openRequestForEdit(row)}
                          title={t('requests.database.table.editTitle')}
                        >
                          <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs font-semibold">
                            {requestDisplayNo(row)}
                          </td>
                          <td className="max-w-[240px] px-3 py-2.5">
                            <div className="truncate font-medium" title={row.title}>
                              {row.title}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                            <span
                              className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                                STATUS_PILL[row.status] ??
                                'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]'
                              }`}
                            >
                              {requestStatusLabel(row.status)}
                            </span>
                          </td>
                          <td className="app-hide-xs max-w-[140px] px-3 py-2.5 text-xs text-[var(--color-fg-muted)]">
                            <span className="line-clamp-2">{row.requester_name || '—'}</span>
                          </td>
                          <td className="app-hide-xs whitespace-nowrap px-3 py-2.5 text-xs text-[var(--color-fg-muted)]">
                            {fmtRuShortDateTime(row.opened_at ?? row.created_at, locale)}
                          </td>
                          <td className="app-hide-xs whitespace-nowrap px-3 py-2.5 text-xs text-[var(--color-fg-muted)]">
                            {fmtRuShortDateTime(row.closed_at ?? row.planned_close_at, locale)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                            {requestPriorityLabel(row.priority)}
                          </td>
                          <td className="app-hide-xs max-w-[180px] px-3 py-2.5 text-xs text-[var(--color-fg-muted)]">
                            <span className="line-clamp-2">{row.category || '—'}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* Шаблоны */}
        {tab === 'templates' ? (
          <div className="min-w-0 lg:col-span-12">

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="lg:col-span-4">
                <div className="app-card rounded-2xl border-[var(--color-border)] p-3 sm:p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] pb-2">
                    <span className="h-6 w-1 rounded-full bg-blue-600/90" aria-hidden />
                    <h2 className="font-[family-name:var(--font-display)] text-sm font-semibold tracking-tight text-[var(--color-fg)]">
                      {tplEditingId != null ? t('requests.templates.editTitle') : t('requests.templates.newTitle')}
                    </h2>
                    {tplEditingId != null ? (
                      <span className="rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900 ring-1 ring-amber-200/80">
                        #{tplEditingId}
                      </span>
                    ) : null}
                  </div>

                  <label className="mb-2 block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                      {t('requests.templates.templateTitle')}
                    </span>
                    <input
                      value={tplTitle}
                      onChange={(e) => setTplTitle(e.target.value)}
                      className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                      placeholder={t('requests.templates.templateTitlePlaceholder')}
                    />
                  </label>

                  <label className="mb-2 block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                      {t('requests.templates.description')}
                    </span>
                    <textarea
                      value={tplDescription}
                      onChange={(e) => setTplDescription(e.target.value)}
                      rows={2}
                      className="w-full resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                    />
                  </label>

                  <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <DirectoryRequesterPicker
                      users={userDir}
                      value={tplRequesterName}
                      onChange={setTplRequesterName}
                      label={t('requests.templates.requesterDefault')}
                      placeholder={t('requests.templates.requesterPlaceholder')}
                      hint={null}
                    />
                    <CategoryPicker
                      value={tplCategory}
                      onChange={setTplCategory}
                      tree={categoryTree}
                      label={t('requests.templates.categoryDefault')}
                    />
                  </div>

                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.statusDefault')}
                      </span>
                      <select
                        value={tplStatus}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestStatus(next)) setTplStatus(next)
                        }}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-medium text-[var(--color-fg)]"
                      >
                        {REQUEST_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {requestStatusLabel(status)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.priorityDefault')}
                      </span>
                      <select
                        value={tplPriority}
                        onChange={(e) => {
                          const next = e.target.value
                          if (isRequestPriority(next)) setTplPriority(next)
                        }}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm font-medium text-[var(--color-fg)]"
                      >
                        {REQUEST_PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {requestPriorityLabel(p)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.openedAt')}
                      </span>
                      <input
                        type="datetime-local"
                        value={tplOpenedAtLocal}
                        onChange={(e) => setTplOpenedAtLocal(e.target.value)}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                        {t('requests.templates.plannedCloseAt')}
                      </span>
                      <input
                        type="datetime-local"
                        value={tplPlannedCloseLocal}
                        onChange={(e) => setTplPlannedCloseLocal(e.target.value)}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                      />
                      <div className="mt-1 flex flex-wrap gap-1">
                        {DURATION_PRESETS_MIN.map((p) => (
                          <button
                            key={`tpl-${p.minutes}`}
                            type="button"
                            className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
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

                  <label className="mb-2 block">
                    <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                      {t('requests.templates.closedAt')}
                    </span>
                    <label className="mb-1 flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-1">
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
                      <span className="text-[11px] leading-snug text-[var(--color-fg)]">
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
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)]"
                      />
                    ) : null}
                  </label>

                  <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <DirectoryAssigneesPicker
                      users={userDir}
                      selectedIds={tplAssigneeIds}
                      onChange={setTplAssigneeIds}
                      className="min-w-0"
                      inputClassName="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                      hint={null}
                    />
                    <ComputerPicker
                      computers={pcList}
                      valueId={tplComputerId}
                      onChange={setTplComputerId}
                      className="relative min-w-0"
                      labelClassName="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]"
                      inputClassName="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
                    />
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row">
                    {tplEditingId != null ? (
                      <button
                        type="button"
                        disabled={tplBusy}
                        onClick={() => resetTemplateForm()}
                        className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-2 text-sm font-semibold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] disabled:opacity-50 sm:w-auto sm:min-w-[7rem]"
                      >
                        {t('requests.templates.cancel')}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      disabled={tplBusy || !tplTitle.trim()}
                      onClick={() => void saveTemplateFromForm()}
                      className="app-btn app-btn-primary w-full flex-1 !min-h-[40px] !text-sm"
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

                <div className="space-y-2">
                  {tplLoading ? (
                    <p className="app-empty-state">{t('requests.templates.loading')}</p>
                  ) : tplRows.length === 0 ? (
                    <p className="app-empty-state">{t('requests.templates.empty')}</p>
                  ) : (
                    tplRows.map((tpl) => (
                      <article
                        key={tpl.id}
                        className="app-card px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                          <h3 className="min-w-0 flex-1 text-sm font-semibold text-[var(--color-fg)]">{tpl.title}</h3>
                          <span
                            className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_PILL[tpl.status] ?? 'bg-[var(--color-surface-muted)] text-[var(--color-fg)] ring-1 ring-slate-200'}`}
                          >
                            {requestStatusLabel(tpl.status)}
                          </span>
                          <button
                            type="button"
                            onClick={() => applyTemplateToForm(tpl)}
                            className="app-btn app-btn-primary !min-h-0 !px-2.5 !py-1 !text-[11px]"
                          >
                            {t('requests.templates.apply')}
                          </button>
                          <button
                            type="button"
                            onClick={() => beginEditTemplate(tpl)}
                            className="app-btn app-btn-secondary !min-h-0 !px-1.5 !py-1"
                            title={t('requests.templates.edit')}
                            aria-label={t('requests.templates.edit')}
                          >
                            <IconPencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={tplBusy}
                            onClick={() => void deleteTemplate(tpl.id, tpl.title)}
                            className="app-btn app-btn-secondary !min-h-0 !px-1.5 !py-1 disabled:opacity-50"
                            title={t('requests.templates.delete')}
                            aria-label={t('requests.templates.delete')}
                          >
                            <IconTrash className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {tpl.description ? (
                          <p className="mt-1 line-clamp-1 text-xs text-[var(--color-fg-muted)]">{tpl.description}</p>
                        ) : null}
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-subtle)]">
                          {tpl.requester_name ? <span>{t('requests.templates.requester', { name: tpl.requester_name })}</span> : null}
                          {tpl.category ? <span>{t('requests.templates.category', { name: tpl.category })}</span> : null}
                          {tpl.assignee_usernames && tpl.assignee_usernames.length > 0 ? (
                            <span className="font-medium text-[var(--color-fg-muted)]" title={tpl.assignee_usernames.join(', ')}>
                              {t('requests.templates.assignees', { names: tpl.assignee_usernames.join(', ') })}
                            </span>
                          ) : null}
                          {tpl.computer_id ? <span>{t('requests.templates.pc', { id: tpl.computer_id })}</span> : null}
                          <span>{requestPriorityLabel(tpl.priority)}</span>
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
