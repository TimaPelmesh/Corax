import { useMemo } from 'react'
import type { ServiceRequestRow } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import type { StatsBasis, StatsGroup } from './shared'
import {
  buildAssigneeDetail,
  buildStatsSeries,
  computeStatsExtra,
  computeStatsKpi,
  countByName,
  countByPriority,
  countByStatus,
  filterStatsRows,
} from './statsModel'

export function useRequestStats(
  rows: ServiceRequestRow[],
  opts: {
    from: string
    to: string
    basis: StatsBasis
    group: StatsGroup
    onlyWithPlanned: boolean
    onlyOverdue: boolean
  },
) {
  const t = useT()

  const statsRows = useMemo(
    () =>
      filterStatsRows(rows, {
        from: opts.from,
        to: opts.to,
        basis: opts.basis,
        onlyWithPlanned: opts.onlyWithPlanned,
        onlyOverdue: opts.onlyOverdue,
      }),
    [opts.basis, opts.from, opts.onlyOverdue, opts.onlyWithPlanned, opts.to, rows],
  )

  const statsSeries = useMemo(
    () => buildStatsSeries(statsRows, opts.basis, opts.group),
    [opts.basis, opts.group, statsRows],
  )

  const statsCategoryItems = useMemo(
    () => countByName(statsRows, (row) => row.category ?? '—'),
    [statsRows],
  )
  const statsRequesterItems = useMemo(
    () => countByName(statsRows, (row) => row.requester_name ?? '—'),
    [statsRows],
  )
  const statsAssigneeItems = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of statsRows) {
      const names = row.assignee_usernames?.length ? row.assignee_usernames : [t('requests.statsData.noAssignee')]
      for (const name of names) map.set(name, (map.get(name) ?? 0) + 1)
    }
    return [...map.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }, [statsRows, t])

  const statsAssigneeDetail = useMemo(
    () => buildAssigneeDetail(statsRows, t('requests.statsData.noAssignee')),
    [statsRows, t],
  )
  const statsAssigneeLoadTotal = useMemo(
    () => statsAssigneeDetail.reduce((sum, row) => sum + row.count, 0),
    [statsAssigneeDetail],
  )
  const statsPriorityItems = useMemo(() => countByPriority(statsRows), [statsRows])
  const statsStatusItems = useMemo(() => countByStatus(statsRows), [statsRows])
  const statsKpi = useMemo(() => computeStatsKpi(statsRows), [statsRows])
  const statsPeriodLabel = useMemo(() => {
    const from = opts.from.trim() || t('requests.statsData.noDataStart')
    const to = opts.to.trim() || t('requests.statsData.today')
    return `${from} - ${to}`
  }, [opts.from, opts.to, t])
  const statsExtra = useMemo(
    () =>
      computeStatsExtra(statsKpi, {
        from: opts.from,
        to: opts.to,
        categoryItems: statsCategoryItems,
        assigneeItems: statsAssigneeItems,
        seriesItems: statsSeries.items,
        t,
      }),
    [opts.from, opts.to, statsAssigneeItems, statsCategoryItems, statsKpi, statsSeries.items, t],
  )

  return {
    statsRows,
    statsSeries,
    statsCategoryItems,
    statsRequesterItems,
    statsAssigneeItems,
    statsAssigneeDetail,
    statsAssigneeLoadTotal,
    statsPriorityItems,
    statsStatusItems,
    statsKpi,
    statsPeriodLabel,
    statsExtra,
  }
}
