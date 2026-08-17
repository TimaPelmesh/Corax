import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type DashboardSegmentKind, type DashboardSummary } from '../api'
import { DashboardDrilldownPanel, type DashboardDrilldownSelection } from '../components/DashboardDrilldown'
import {
  ClosedTicketsDynamicsChart,
  DashboardSkeleton,
  DiskDevicesByAvgList,
  DonutDistribution,
  formatAvgCloseHours,
  MiniStatCard,
  PhysicalDisksPanel,
  RankedMetricList,
  SectionCard,
} from '../components/dashboard/DashboardWidgets'
import { DashboardCalendar } from '../components/dashboard/DashboardCalendar'
import {
  IconActivity,
  IconClock,
  IconPcs,
  IconPrinter,
  IconSignal,
  IconSoftware,
} from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import {
  DASHBOARD_WIDGETS_KEY,
  readWidgets,
  type WidgetVisibility,
} from '../lib/dashboardPrefs'
import { useToast } from '../ToastContext'

export function DashboardPage() {
  const t = useT()
  const toast = useToast()
  const [data, setData] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [widgets, setWidgets] = useState<WidgetVisibility>(() => readWidgets())
  const [drilldown, setDrilldown] = useState<DashboardDrilldownSelection | null>(null)

  const toggleDrilldown = useCallback((next: DashboardDrilldownSelection) => {
    setDrilldown((cur) =>
      cur?.kind === next.kind && cur?.name === next.name && cur?.chartTitle === next.chartTitle ? null : next,
    )
  }, [])

  const drillChart = useCallback(
    (kind: DashboardSegmentKind, chartTitle: string) => ({
      onItemClick: (name: string) => toggleDrilldown({ kind, name, chartTitle }),
      selectedName: drilldown?.kind === kind && drilldown.chartTitle === chartTitle ? drilldown.name : null,
    }),
    [drilldown, toggleDrilldown],
  )

  const load = useCallback(async () => {
    try {
      setData(await api.dashboardSummary())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('common.error'))
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === DASHBOARD_WIDGETS_KEY) setWidgets(readWidgets())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const closedPoints = data?.service_requests_closed_series ?? []
  const closedTotal = closedPoints.length
    ? (closedPoints[closedPoints.length - 1].cumulative ?? closedPoints.reduce((sum, point) => sum + point.count, 0))
    : 0

  return (
    <div>
      <h1 className="sr-only">{t('titles.dashboard')}</h1>
      {loading ? (
        <DashboardSkeleton />
      ) : data ? (
        <div className="dashboard-enter space-y-4">
          {data.computers_total === 0 ? (
            <div className="app-card px-4 py-3 text-sm text-[var(--color-fg-muted)]">
              {t('dashboard.emptyFleet')}
            </div>
          ) : null}
          <div className="dashboard-stagger grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <MiniStatCard
              label={t('dashboard.stats.computers.label')}
              value={data.computers_total}
              sub={t('dashboard.stats.computers.sub')}
              icon={<IconPcs className="h-4 w-4" />}
              to="/computers"
            />
            <MiniStatCard
              label={t('dashboard.stats.softwareTitles.label')}
              value={data.software_unique_titles}
              sub={t('dashboard.stats.softwareTitles.sub')}
              icon={<IconSoftware className="h-4 w-4" />}
              to="/software"
            />
            <MiniStatCard
              label={t('dashboard.stats.printers.label')}
              value={data.snmp_printers_total}
              sub={t('dashboard.stats.printers.sub')}
              icon={<IconPrinter className="h-4 w-4" />}
              to="/printers"
            />
            <MiniStatCard
              label={t('dashboard.stats.requestsAvgClose.label')}
              value={formatAvgCloseHours(data.service_requests_avg_close_hours, t)}
              sub={t('dashboard.stats.requestsAvgClose.sub')}
              icon={<IconClock className="h-4 w-4" />}
            />
            <MiniStatCard
              label={t('dashboard.stats.requestsActive.label')}
              value={data.service_requests_active}
              sub={t('dashboard.stats.requestsActive.sub')}
              icon={<IconActivity className="h-4 w-4" />}
              to="/requests/database"
            />
            <MiniStatCard
              label={t('dashboard.stats.computersOnline.label')}
              value={data.computers_online ?? 0}
              sub={t('dashboard.stats.computersOnline.sub')}
              icon={<IconSignal className="h-4 w-4" />}
              to="/computers?ping=online"
            />
          </div>

          <div
            className={`dashboard-stagger grid gap-3 ${
              widgets['list.calendar'] ? 'xl:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]' : ''
            }`}
          >
            <div className="app-panel flex min-w-0 flex-col !rounded-xl !p-3.5 sm:!p-4">
              <div className="mb-2 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
                    {t('dashboard.tickets.closedDynamics')}
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--color-fg-subtle)]">
                    {t('dashboard.tickets.closedDynamicsHint')}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-[1.1rem] font-semibold tabular-nums leading-none text-[var(--color-fg)]">{closedTotal}</div>
                  <div className="mt-0.5 text-[9px] font-medium text-[var(--color-fg-subtle)]">{t('dashboard.tickets.closedTotal')}</div>
                </div>
              </div>
              <ClosedTicketsDynamicsChart
                points={closedPoints}
                granularity={data.service_requests_closed_granularity || 'day'}
                showTotal={false}
              />
              <div className="mt-1.5 text-right">
                <Link
                  to="/requests/database"
                  className="text-[11px] font-medium text-[var(--color-primary)] no-underline hover:underline"
                >
                  {t('dashboard.tickets.openList')}
                </Link>
              </div>
            </div>

            {widgets['list.calendar'] ? <DashboardCalendar compact /> : null}
          </div>

          <div className="space-y-4">
              {widgets['dist.by_os'] ||
              widgets['dist.by_manufacturer'] ||
              widgets['dist.ram_buckets'] ||
              widgets['dist.top_monitors'] ||
              widgets['dist.by_system_model'] ||
              widgets['dist.top_cpu'] ||
              widgets['dist.physical_disks'] ? (
                <div className="dashboard-stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {widgets['dist.by_os'] ? (
                    <SectionCard title={t('dashboard.sections.byOs.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      <DonutDistribution
                          items={data.by_os}
                          emptyText={t('dashboard.sections.byOs.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('os', t('dashboard.sections.byOs.title'))}
                        />
                    </SectionCard>
                  ) : null}
                  {widgets['dist.by_manufacturer'] ? (
                    <SectionCard title={t('dashboard.sections.byManufacturer.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      <DonutDistribution
                          items={data.by_manufacturer}
                          emptyText={t('dashboard.sections.byManufacturer.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('manufacturer', t('dashboard.sections.byManufacturer.title'))}
                        />
                    </SectionCard>
                  ) : null}
                  {widgets['dist.ram_buckets'] ? (
                    <SectionCard title={t('dashboard.sections.ram.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      <DonutDistribution
                          items={data.ram_buckets.map((b) => ({ name: b.label, count: b.count }))}
                          emptyText={t('dashboard.sections.ram.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('ram', t('dashboard.sections.ram.title'))}
                        />
                    </SectionCard>
                  ) : null}
                  {widgets['dist.top_monitors'] ? (
                    <SectionCard title={t('dashboard.sections.monitors.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      <DonutDistribution
                          items={data.top_monitors}
                          emptyText={t('dashboard.sections.monitors.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('monitor', t('dashboard.sections.monitors.title'))}
                        />
                    </SectionCard>
                  ) : null}
                  {widgets['dist.by_system_model'] ? (
                    <SectionCard
                      title={t('dashboard.sections.bySystemModel.title')}
                      dense
                      className="flex flex-col"
                      bodyClassName="flex flex-1 items-center justify-center"
                    >
                      <DonutDistribution
                          items={data.by_system_model}
                          emptyText={t('dashboard.sections.bySystemModel.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('system_model', t('dashboard.sections.bySystemModel.title'))}
                        />
                    </SectionCard>
                  ) : null}
                  {widgets['dist.top_cpu'] ? (
                    <SectionCard title={t('dashboard.sections.cpu.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      <DonutDistribution
                          items={data.top_cpu.map((c) => ({ name: c.name, count: c.count }))}
                          emptyText={t('dashboard.sections.cpu.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('cpu', t('dashboard.sections.cpu.title'))}
                        />
                    </SectionCard>
                  ) : null}
                  {widgets['dist.physical_disks'] ? (
                    <SectionCard
                      title={t('dashboard.sections.physicalDisks.title')}
                      description={t('dashboard.sections.physicalDisks.description')}
                      dense
                      className="flex flex-col"
                      bodyClassName="flex flex-1 items-center justify-center"
                    >
                      <PhysicalDisksPanel
                        total={data.physical_disks_total}
                        byVariant={data.physical_disks_by_variant}
                        {...drillChart('physical_disk', t('dashboard.sections.physicalDisks.title'))}
                      />
                    </SectionCard>
                  ) : null}
                </div>
              ) : null}

              {widgets['list.top_disk_devices'] || widgets['list.top_software'] ? (
                <div className="grid items-stretch gap-4 lg:grid-cols-2">
                  {widgets['list.top_disk_devices'] ? (
                    <SectionCard
                      title={t('dashboard.sections.localDisks.title')}
                      description={t('dashboard.sections.localDisks.description')}
                      dense
                      className="flex h-full min-w-0 flex-col"
                      bodyClassName="flex-1"
                    >
                      <DiskDevicesByAvgList
                        items={data.top_disk_devices}
                        emptyText={t('dashboard.sections.localDisks.empty')}
                        {...drillChart('hostname', t('dashboard.sections.localDisks.title'))}
                      />
                    </SectionCard>
                  ) : null}

                  {widgets['list.top_software'] ? (
                    <SectionCard
                      title={t('dashboard.sections.topSoftware.title')}
                      description={t('dashboard.sections.topSoftware.description')}
                      dense
                      className="flex h-full min-w-0 flex-col"
                      bodyClassName="flex-1"
                      action={
                        <Link
                          to="/software"
                          className="shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-2 text-xs font-semibold text-[var(--color-fg)] shadow-sm transition hover:border-[var(--color-border)] hover:bg-[var(--color-surface-muted)]"
                        >
                          {t('dashboard.sections.topSoftware.action')}
                        </Link>
                      }
                    >
                      <RankedMetricList
                        items={data.top_software.slice(0, 10)}
                        emptyText={t('dashboard.sections.topSoftware.empty')}
                        {...drillChart('software', t('dashboard.sections.topSoftware.title'))}
                      />
                    </SectionCard>
                  ) : null}
                </div>
              ) : null}

              {widgets['list.peripheral_kinds'] || widgets['list.top_peripherals'] ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  {widgets['list.peripheral_kinds'] ? (
                    <SectionCard
                      title={t('dashboard.sections.peripheralKinds.title')}
                      description={t('dashboard.sections.peripheralKinds.description')}
                      dense
                    >
                      {!data.peripheral_kinds.length ? (
                        <p className="app-empty-state">
                          {t('dashboard.sections.peripheralKinds.empty')}
                        </p>
                      ) : (
                        <ul className="space-y-3 text-sm">
                          {data.peripheral_kinds.map((p) => {
                            const pct = Math.round((p.pc_count / Math.max(1, data.computers_total)) * 100)
                            const tip = t('dashboard.sections.peripheralKinds.tip', {
                              label: p.label,
                              count: p.pc_count,
                              pct,
                            })
                            const isSelected =
                              drilldown?.kind === 'peripheral_kind' &&
                              drilldown.chartTitle === t('dashboard.sections.peripheralKinds.title') &&
                              drilldown.name === p.kind
                            return (
                              <li
                                key={p.kind}
                                className={`rounded-xl px-3 py-2 ring-1 transition ${
                                  isSelected
                                    ? 'bg-neutral-950 ring-neutral-950'
                                    : 'bg-[var(--color-surface-muted)]/50 ring-neutral-100 hover:bg-[var(--color-surface)] hover:ring-neutral-200/80'
                                } cursor-pointer`}
                                onClick={() =>
                                  toggleDrilldown({
                                    kind: 'peripheral_kind',
                                    name: p.kind,
                                    chartTitle: t('dashboard.sections.peripheralKinds.title'),
                                    displayName: p.label,
                                  })
                                }
                                title={t('dashboard.showPcList')}
                              >
                                <div className="mb-1.5 flex justify-between gap-2">
                                  <span className={`font-medium ${isSelected ? 'text-white' : 'text-[var(--color-fg-muted)]'}`}>
                                    {p.label}
                                  </span>
                                  <span
                                    className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold ring-1 ${
                                      isSelected
                                        ? 'bg-[var(--color-surface)]/10 text-white ring-white/20'
                                        : 'bg-[var(--color-surface)] text-[var(--color-fg)] ring-neutral-200/60'
                                    }`}
                                  >
                                    {p.pc_count}
                                  </span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]" title={tip}>
                                  <div
                                    className="h-full rounded-full bg-[var(--color-primary)]"
                                    style={{ width: `${Math.max(5, pct)}%` }}
                                    title={tip}
                                  />
                                </div>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['list.top_peripherals'] ? (
                    <SectionCard title={t('dashboard.sections.topPeripherals.title')} dense>
                      <RankedMetricList
                        items={data.top_peripherals}
                        emptyText={t('dashboard.sections.topPeripherals.empty')}
                        {...drillChart('peripheral', t('dashboard.sections.topPeripherals.title'))}
                      />
                    </SectionCard>
                  ) : null}
                </div>
              ) : null}
          </div>

          <DashboardDrilldownPanel selection={drilldown} onClose={() => setDrilldown(null)} />
        </div>
      ) : null}
    </div>
  )
}
