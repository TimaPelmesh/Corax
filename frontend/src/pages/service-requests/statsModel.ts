import type { ServiceRequestRow } from '../../api'
import type { MessageKey } from '../../i18n/LocaleContext'
import {
  parseIsoToDate,
  pickLastChangeIso,
  requestPriorityLabel,
  requestStatusLabel,
  type StatsBasis,
  type StatsGroup,
} from './shared'

export type NamedCount = { name: string; count: number }

export type StatsSeriesPoint = { key: string; total: number; byStatus: Record<string, number> }

export type StatsAssigneeRow = {
  name: string
  count: number
  done: number
  active: number
  avgHours: number | null
}

export type StatsKpi = {
  total: number
  done: number
  cancelled: number
  active: number
  overdue: number
  completionRate: number
  overdueRate: number
  avgCloseHours: number | null
  slaHitRate: number
  medianCloseHours: number | null
  highShare: number
  openN: number
  progressN: number
}

export function requestBasisIso(row: ServiceRequestRow, basis: StatsBasis): string | null {
  if (basis === 'closed') return row.closed_at ?? null
  if (basis === 'last_change') return pickLastChangeIso(row)
  return row.opened_at ?? row.created_at
}

export function isRequestOverdue(row: ServiceRequestRow, now = Date.now()): boolean {
  if (!row.planned_close_at) return false
  const planned = parseIsoToDate(row.planned_close_at)
  if (!planned) return false
  return planned.getTime() < now && !row.closed_at && row.status !== 'done' && row.status !== 'cancelled'
}

export function filterStatsRows(
  rows: ServiceRequestRow[],
  opts: {
    from: string
    to: string
    basis: StatsBasis
    onlyWithPlanned: boolean
    onlyOverdue: boolean
    now?: number
  },
): ServiceRequestRow[] {
  const fromMs = opts.from.trim() ? new Date(`${opts.from.trim()}T00:00:00`).getTime() : -Infinity
  const toMs = opts.to.trim() ? new Date(`${opts.to.trim()}T23:59:59`).getTime() : Infinity
  const now = opts.now ?? Date.now()
  return rows.filter((row) => {
    const iso = requestBasisIso(row, opts.basis)
    const date = iso ? parseIsoToDate(iso) : null
    const ts = date ? date.getTime() : NaN
    if (!Number.isFinite(ts)) return false
    if (ts < fromMs || ts > toMs) return false
    if (opts.onlyWithPlanned && !row.planned_close_at) return false
    if (opts.onlyOverdue && !isRequestOverdue(row, now)) return false
    return true
  })
}

function periodKey(date: Date, group: StatsGroup): string {
  if (group === 'week') {
    const tmp = new Date(date)
    tmp.setHours(0, 0, 0, 0)
    tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7))
    const week1 = new Date(tmp.getFullYear(), 0, 4)
    const week = 1 + Math.round(((tmp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
    return `${tmp.getFullYear()}-W${String(week).padStart(2, '0')}`
  }
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function buildStatsSeries(
  rows: ServiceRequestRow[],
  basis: StatsBasis,
  group: StatsGroup,
): { items: StatsSeriesPoint[]; max: number } {
  const map = new Map<string, { total: number; byStatus: Record<string, number> }>()
  for (const row of rows) {
    const iso = requestBasisIso(row, basis)
    const date = iso ? parseIsoToDate(iso) : null
    if (!date) continue
    const key = periodKey(date, group)
    const cur = map.get(key) ?? { total: 0, byStatus: {} }
    cur.total += 1
    cur.byStatus[row.status] = (cur.byStatus[row.status] ?? 0) + 1
    map.set(key, cur)
  }
  const items = [...map.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => a.key.localeCompare(b.key))
  const max = Math.max(1, ...items.map((item) => item.total))
  return { items, max }
}

export function countByName(rows: ServiceRequestRow[], nameOf: (row: ServiceRequestRow) => string): NamedCount[] {
  const map = new Map<string, number>()
  for (const row of rows) {
    const name = nameOf(row)
    map.set(name, (map.get(name) ?? 0) + 1)
  }
  return [...map.entries()].map(([name, count]) => ({ name, count }))
}

export function buildAssigneeDetail(rows: ServiceRequestRow[], noAssignee: string): StatsAssigneeRow[] {
  const map = new Map<string, { total: number; done: number; active: number; hours: number[] }>()
  for (const row of rows) {
    const names = row.assignee_usernames?.length ? row.assignee_usernames : [noAssignee]
    for (const name of names) {
      const cur = map.get(name) ?? { total: 0, done: 0, active: 0, hours: [] }
      cur.total += 1
      if (row.status === 'done') {
        cur.done += 1
        const opened = parseIsoToDate(row.opened_at ?? row.created_at)
        const closed = parseIsoToDate(row.closed_at ?? '')
        if (opened && closed) {
          const hours = (closed.getTime() - opened.getTime()) / 3_600_000
          if (Number.isFinite(hours) && hours >= 0) cur.hours.push(hours)
        }
      }
      if (row.status === 'open' || row.status === 'in_progress') cur.active += 1
      map.set(name, cur)
    }
  }
  return [...map.entries()]
    .map(([name, value]) => ({
      name,
      count: value.total,
      done: value.done,
      active: value.active,
      avgHours: value.hours.length
        ? Math.round((value.hours.reduce((a, b) => a + b, 0) / value.hours.length) * 10) / 10
        : null,
    }))
    .sort((a, b) => b.count - a.count)
}

export function computeStatsKpi(rows: ServiceRequestRow[], now = Date.now()): StatsKpi {
  const total = rows.length
  const done = rows.filter((row) => row.status === 'done').length
  const cancelled = rows.filter((row) => row.status === 'cancelled').length
  const active = rows.filter((row) => row.status === 'open' || row.status === 'in_progress').length
  const overdue = rows.filter((row) => isRequestOverdue(row, now)).length
  const closedDurations = rows
    .filter((row) => row.status === 'done')
    .map((row) => {
      const opened = parseIsoToDate(row.opened_at ?? row.created_at)
      const closed = parseIsoToDate(row.closed_at ?? '')
      if (!opened || !closed) return null
      const hours = (closed.getTime() - opened.getTime()) / 3_600_000
      return Number.isFinite(hours) && hours >= 0 ? hours : null
    })
    .filter((value): value is number => value != null)
  const closedWithPlan = rows.filter((row) => row.closed_at && row.planned_close_at)
  const inSla = closedWithPlan.filter((row) => {
    const planned = parseIsoToDate(row.planned_close_at ?? '')
    const closed = parseIsoToDate(row.closed_at ?? '')
    return Boolean(planned && closed && closed.getTime() <= planned.getTime())
  }).length
  const sortedDur = [...closedDurations].sort((a, b) => a - b)
  const highN = rows.filter((row) => row.priority === 'high').length
  return {
    total,
    done,
    cancelled,
    active,
    overdue,
    completionRate: total > 0 ? Math.round((done / total) * 100) : 0,
    overdueRate: total > 0 ? Math.round((overdue / total) * 100) : 0,
    avgCloseHours: closedDurations.length
      ? Math.round((closedDurations.reduce((a, b) => a + b, 0) / closedDurations.length) * 10) / 10
      : null,
    slaHitRate: closedWithPlan.length ? Math.round((inSla / closedWithPlan.length) * 100) : 0,
    medianCloseHours: sortedDur.length ? Math.round(sortedDur[Math.floor(sortedDur.length / 2)] * 10) / 10 : null,
    highShare: total > 0 ? Math.round((highN / total) * 100) : 0,
    openN: rows.filter((row) => row.status === 'open').length,
    progressN: rows.filter((row) => row.status === 'in_progress').length,
  }
}

export function computeStatsExtra(
  kpi: StatsKpi,
  opts: {
    from: string
    to: string
    categoryItems: NamedCount[]
    assigneeItems: NamedCount[]
    seriesItems: StatsSeriesPoint[]
    t: (key: MessageKey, vars?: Record<string, string | number>) => string
  },
): {
  perDay: number
  daySpan: number
  topCat: NamedCount | null
  topAsg: NamedCount | null
  topShare: number
  bullets: string[]
} {
  const from = opts.from ? Date.parse(opts.from) : NaN
  const to = opts.to ? Date.parse(opts.to) : Date.now()
  const daySpan = Number.isFinite(from) ? Math.max(1, Math.round((to - from) / 86_400_000) + 1) : 30
  const perDay = Math.round((kpi.total / daySpan) * 10) / 10
  const cats = [...opts.categoryItems].sort((a, b) => b.count - a.count)
  const topCat = cats[0] ?? null
  const topAsg = opts.assigneeItems[0] ?? null
  const topShare = topAsg && kpi.total > 0 ? Math.round((topAsg.count / kpi.total) * 100) : 0
  const bullets: string[] = []
  const trendItems = opts.seriesItems
  if (trendItems.length >= 6) {
    const last = trendItems.slice(-3).reduce((sum, item) => sum + item.total, 0)
    const prev = trendItems.slice(-6, -3).reduce((sum, item) => sum + item.total, 0)
    if (prev > 0 && last >= prev * 1.25) bullets.push(opts.t('requests.stats.insightTrendUp'))
    else if (prev > 0 && last <= prev * 0.75) bullets.push(opts.t('requests.stats.insightTrendDown'))
  }
  if (kpi.total > 0) {
    if (kpi.overdueRate >= 10) {
      bullets.push(opts.t('requests.stats.insightOverdue', { n: kpi.overdue, pct: kpi.overdueRate }))
    }
    if (kpi.slaHitRate > 0) {
      bullets.push(opts.t('requests.stats.insightSla', { pct: kpi.slaHitRate }))
    }
    if (kpi.highShare >= 20) {
      bullets.push(opts.t('requests.stats.insightHigh', { pct: kpi.highShare }))
    }
    bullets.push(opts.t('requests.stats.insightDone', { pct: kpi.completionRate, n: kpi.done }))
  }
  return { perDay, daySpan, topCat, topAsg, topShare, bullets: bullets.slice(0, 6) }
}

export function countByStatus(rows: ServiceRequestRow[]): NamedCount[] {
  return countByName(rows, (row) => requestStatusLabel(row.status))
}

export function countByPriority(rows: ServiceRequestRow[]): NamedCount[] {
  return countByName(rows, (row) => requestPriorityLabel(row.priority))
}
