import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, type DashboardDiskDeviceRank, type DashboardSegmentKind, type DashboardSummary } from '../api'
import { DashboardDrilldownPanel, type DashboardDrilldownSelection } from '../components/DashboardDrilldown'
import { IconDashboard, IconDisk, IconPcs, IconPrinter, IconSoftware, IconTag } from '../components/icons'
import { donutColorsForTheme } from '../chartColors'
import { useT } from '../i18n/LocaleContext'
import { useTheme } from '../ThemeContext'
import { useToast } from '../ToastContext'

type TranslateFn = ReturnType<typeof useT>

/** Короткие подписи в легенде дашборда (полное имя — в title). */
function formatDashboardLabel(name: string): string {
  let n = name.trim()
  n = n.replace(/^(microsoft|майкрософт)\s+/i, '')
  n = n.replace(/\s+operating\s+system$/i, '')
  n = n.replace(/\s+для\s+рабочих\s+станций$/i, ' WS')
  n = n.replace(/\s+профессиональная$/i, ' Pro')
  n = n.replace(/^intel\(r\)\s+core\(tm\)\s+/i, 'Core ')
  n = n.replace(/^intel\(r\)\s+/i, '')
  n = n.replace(/\s+cpu\s*@.*$/i, '')
  if (n.length > 26) return `${n.slice(0, 24)}…`
  return n
}

type DashboardChartsMode = 'donut' | 'bars'
const DASHBOARD_MODE_KEY = 'dashboard.charts.mode'
const DASHBOARD_WIDGETS_KEY = 'dashboard.widgets.v1'

type DashboardWidgetId =
  | 'stat.computers_total'
  | 'stat.software_unique_titles'
  | 'stat.tags_in_directory'
  | 'stat.snmp_printers_total'
  | 'stat.physical_disks_total'
  | 'dist.by_os'
  | 'dist.by_manufacturer'
  | 'dist.ram_buckets'
  | 'dist.top_monitors'
  | 'dist.by_system_model'
  | 'dist.top_cpu'
  | 'dist.physical_disks'
  | 'list.top_disk_devices'
  | 'list.top_software'
  | 'list.peripheral_kinds'
  | 'list.top_peripherals'

type WidgetVisibility = Record<DashboardWidgetId, boolean>

const DEFAULT_WIDGETS: WidgetVisibility = {
  'stat.computers_total': true,
  'stat.software_unique_titles': true,
  'stat.tags_in_directory': true,
  'stat.snmp_printers_total': true,
  'stat.physical_disks_total': true,
  'dist.by_os': true,
  'dist.by_manufacturer': true,
  'dist.ram_buckets': true,
  'dist.top_monitors': true,
  'dist.by_system_model': true,
  'dist.top_cpu': true,
  'dist.physical_disks': true,
  'list.top_disk_devices': true,
  'list.top_software': true,
  'list.peripheral_kinds': true,
  'list.top_peripherals': true,
}

function readChartsMode(): DashboardChartsMode {
  try {
    const v = localStorage.getItem(DASHBOARD_MODE_KEY)
    return v === 'bars' || v === 'donut' ? v : 'donut'
  } catch {
    return 'donut'
  }
}

function readWidgets(): WidgetVisibility {
  try {
    const raw = localStorage.getItem(DASHBOARD_WIDGETS_KEY)
    if (!raw) return { ...DEFAULT_WIDGETS }
    const parsed = JSON.parse(raw) as Partial<WidgetVisibility>
    const out: WidgetVisibility = { ...DEFAULT_WIDGETS }
    for (const k of Object.keys(DEFAULT_WIDGETS) as DashboardWidgetId[]) {
      if (typeof parsed[k] === 'boolean') out[k] = Boolean(parsed[k])
    }
    if (
      typeof (parsed as { 'stat.workstation_printers_total'?: boolean })['stat.workstation_printers_total'] ===
        'boolean' &&
      typeof parsed['stat.snmp_printers_total'] !== 'boolean'
    ) {
      out['stat.snmp_printers_total'] = Boolean(
        (parsed as { 'stat.workstation_printers_total'?: boolean })['stat.workstation_printers_total'],
      )
    }
    return out
  } catch {
    return { ...DEFAULT_WIDGETS }
  }
}

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
  tallLegend,
  svgSizePx,
  /** Ровные отступы в легенде (только «железные» карточки: мониторы / WMI / CPU). */
  evenLegend,
  onItemClick,
  selectedName,
}: {
  items: { name: string; count: number }[]
  emptyText?: string
  compact?: boolean
  /** Center donut+legend within the card (useful for short legends). */
  center?: boolean
  /** Larger, vertically stretched legend list (good for "Модели (WMI)"). */
  tallLegend?: boolean
  /** Override donut size (px). */
  svgSizePx?: number
  evenLegend?: boolean
  onItemClick?: (name: string) => void
  selectedName?: string | null
}) {
  const t = useT()
  const { theme } = useTheme()
  const donutColors = donutColorsForTheme(theme)
  const [hovered, setHovered] = useState<number | null>(null)
  const normalizedItems = useMemo(() => items.filter((i) => i.count > 0), [items])
  const total = useMemo(() => normalizedItems.reduce((s, i) => s + i.count, 0), [normalizedItems])
  // Keep donut position consistent across cards (avoid auto-centering when legend is short).
  const centered = Boolean(center)

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
        color: donutColors[i % donutColors.length],
      }
    })
  }, [donutColors, normalizedItems, total])

  const clickable = Boolean(onItemClick)

  if (!normalizedItems.length || total <= 0) {
    return (
      <p className="app-empty-state">
        {emptyText ?? t('dashboard.noData')}
      </p>
    )
  }

  const svgSize = svgSizePx ?? (compact ? 132 : 168)
  const even = Boolean(evenLegend)
  const legendWidth = centered ? 'w-[min(100%,14rem)] shrink-0' : even ? 'min-w-0 flex-1' : 'min-w-0 flex-1'
  return (
    <div
      className={centered ? 'flex w-full justify-center' : undefined}
      onMouseLeave={() => setHovered(null)}
    >
      <div
        className={`flex flex-col ${even ? 'gap-3 sm:gap-4' : 'gap-4 sm:gap-5'} sm:flex-row ${
          centered
            ? 'w-fit max-w-full items-center sm:items-center sm:justify-center'
            : 'items-stretch sm:items-start'
        }`}
      >
      <div className="relative shrink-0">
        <svg
          width={svgSize}
          height={svgSize}
          viewBox="0 0 160 160"
          className="drop-shadow-[0_12px_32px_-8px_rgb(15_23_42_/_0.12)] dark:drop-shadow-[0_12px_40px_-6px_rgb(96_165_250_/_0.35)]"
          role="img"
          aria-label={t('dashboard.donutAriaLabel')}
        >
          {segments.length === 1 ? (
            <circle
              cx="80"
              cy="80"
              r="60"
              fill="none"
              stroke={segments[0].color}
              strokeWidth="28"
            />
          ) : null}
          {segments.map((s) => {
            const dim = hovered !== null && hovered !== s.i
            const active = hovered === s.i
            return (
              <path
                key={s.item.name + String(s.i)}
                d={segments.length === 1 ? '' : s.d}
                fill={s.color}
                stroke="color-mix(in srgb, var(--color-surface) 88%, white)"
                strokeWidth={active ? 1.75 : 1.25}
                strokeLinejoin="round"
                className={clickable ? 'cursor-pointer' : undefined}
                style={{
                  opacity: dim ? 0.42 : 1,
                  transition: 'opacity 100ms ease-out',
                }}
                onMouseEnter={() => setHovered(s.i)}
                onClick={clickable ? () => onItemClick?.(s.item.name) : undefined}
                aria-label={clickable ? t('dashboard.showPcsFor', { name: s.item.name }) : undefined}
              />
            )
          })}
        </svg>
        <div
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-3 text-center"
          aria-live="polite"
        >
          <div
            className={`flex w-full max-w-[7.5rem] flex-col items-center justify-center gap-0.5 ${compact ? 'min-h-[4.5rem]' : 'min-h-[5.25rem]'}`}
          >
            <div className="flex min-h-[2rem] w-full flex-col justify-end">
              <span className="text-[11px] font-semibold leading-tight text-transparent" aria-hidden>
                &nbsp;
              </span>
            </div>
            <span
              className={`admin-stat-value leading-none tracking-tight text-[var(--color-fg)] ${compact ? 'text-[1.35rem]' : 'text-[1.65rem]'}`}
            >
              {total}
            </span>
            <div className="flex min-h-[2.35rem] flex-col items-center justify-end gap-0.5">
              <span className="text-[10px] text-transparent" aria-hidden>
                .
              </span>
            </div>
          </div>
        </div>
      </div>
      <ul
        className={
          even
            ? `${legendWidth} space-y-0.5 overflow-y-auto overscroll-contain pr-0.5 [-webkit-overflow-scrolling:touch] sm:max-h-[16rem]`
            : `${legendWidth} ${compact ? 'space-y-1.5 text-[13px]' : 'space-y-2'} ${
                tallLegend && !centered ? 'flex min-h-0 flex-1 flex-col justify-between' : ''
              }`
        }
      >
        {normalizedItems.map((row, i) => {
          const pct = Math.round((row.count / total) * 100)
          const rowDim = hovered !== null && hovered !== i
          const isSelected = selectedName === row.name
          const legendClick = () => onItemClick?.(row.name)
          if (even) {
            const label = formatDashboardLabel(row.name)
            return (
              <li
                key={row.name}
                className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-xs transition-colors duration-150 app-legend-item ${
                  clickable ? 'cursor-pointer' : 'cursor-default'
                } ${isSelected ? 'app-legend-item--selected' : ''}`}
                style={{ opacity: rowDim ? 0.55 : 1 }}
                title={clickable ? t('dashboard.clickForPcList', { name: row.name }) : row.name}
                onMouseEnter={() => setHovered(i)}
                onClick={clickable ? legendClick : undefined}
              >
                <span
                  className="app-legend-swatch h-2 w-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: donutColors[i % donutColors.length] }}
                />
                <span className="min-w-0 truncate font-medium leading-tight">
                  {label}
                </span>
                <span className="font-mono text-xs font-semibold tabular-nums">
                  {row.count}
                </span>
                <span className="text-[10px] tabular-nums app-table-cell-muted">
                  ({pct}%)
                </span>
              </li>
            )
          }
          return (
            <li
              key={row.name}
              className={`flex items-center gap-3 rounded-xl transition-all duration-150 app-legend-item ${
                clickable ? 'cursor-pointer' : 'cursor-default'
              } ${isSelected ? 'app-legend-item--selected' : ''} ${tallLegend ? 'px-2.5 py-2.5 text-[15px]' : 'px-2 py-1.5 text-sm'}`}
              style={{ opacity: rowDim ? 0.55 : 1 }}
              title={clickable ? t('dashboard.clickForPcList', { name: row.name }) : row.name}
              onMouseEnter={() => setHovered(i)}
              onClick={clickable ? legendClick : undefined}
            >
              <span
                className={`app-legend-swatch ${tallLegend ? 'h-3 w-3' : 'mt-0.5 h-2.5 w-2.5'} shrink-0 rounded-sm`}
                style={{ backgroundColor: donutColors[i % donutColors.length] }}
              />
              <span className="min-w-0 flex-1 break-words text-[13px] font-medium leading-snug">
                {row.name}
              </span>
              <span className={`shrink-0 font-mono font-semibold ${tallLegend ? 'text-base' : 'text-sm'}`}>
                {row.count}
              </span>
              <span className={`shrink-0 tabular-nums app-table-cell-muted ${tallLegend ? 'text-sm' : 'text-xs'}`}>
                ({pct}%)
              </span>
            </li>
          )
        })}
      </ul>
      </div>
    </div>
  )
}

function BarDistribution({
  items,
  emptyText,
  valueTitle,
  onItemClick,
  selectedName,
}: {
  items: { name: string; count: number }[]
  emptyText?: string
  valueTitle?: string
  onItemClick?: (name: string) => void
  selectedName?: string | null
}) {
  const t = useT()
  const normalizedItems = useMemo(() => items.filter((i) => i.count > 0), [items])
  const max = useMemo(() => normalizedItems.reduce((m, i) => Math.max(m, i.count), 0), [normalizedItems])
  const effectiveValueTitle = valueTitle ?? t('dashboard.pcsValueTitle')
  if (!normalizedItems.length || max <= 0) {
    return (
      <p className="app-empty-state">
        {emptyText ?? t('dashboard.noData')}
      </p>
    )
  }
  const top = normalizedItems.slice(0, 10)
  const clickable = Boolean(onItemClick)
  return (
    <div className="flex min-h-[11.5rem] items-end gap-1.5 sm:gap-2">
      {top.map((row, idx) => {
        const pct = Math.round((row.count / max) * 100)
        const tip = clickable
          ? t('dashboard.barTipClickable', { name: row.name, valueTitle: effectiveValueTitle, count: row.count })
          : t('dashboard.barTipStatic', { name: row.name, valueTitle: effectiveValueTitle, count: row.count })
        const isSelected = selectedName === row.name
        return (
          <div key={`${row.name}-${idx}`} className="min-w-0 flex-1">
            <div
              className={`group relative h-36 overflow-hidden rounded-2xl bg-[var(--color-surface-muted)] shadow-inner ring-1 transition ${
                isSelected
                  ? 'ring-[var(--color-fg)]'
                  : 'ring-[var(--color-border)] group-hover:ring-[var(--color-border-strong)]'
              } ${clickable ? 'cursor-pointer' : ''}`}
              title={tip}
              aria-label={tip}
              onClick={clickable ? () => onItemClick?.(row.name) : undefined}
            >
              <div
                className="absolute inset-x-0 bottom-0 rounded-t-xl bg-gradient-to-t from-blue-700 via-neutral-800 to-neutral-600 opacity-95 shadow-[0_-4px_16px_-4px_rgb(0_0_0/0.15)] transition-[height] duration-300 ease-out group-hover:opacity-100 dark:from-[#2563eb] dark:via-[#60a5fa] dark:to-[#bae6fd] dark:opacity-100 dark:shadow-[0_-6px_20px_-4px_rgb(56_189_248/0.35)]"
                style={{ height: `${Math.max(6, pct)}%` }}
              />
              <div className="absolute inset-x-0 top-2 px-1.5 text-center font-mono text-[11px] font-semibold tabular-nums text-[var(--color-fg)] drop-shadow-sm">
                {row.count}
              </div>
            </div>
            <div className="mt-2 text-center text-[11px] font-medium leading-snug text-[var(--color-fg-muted)]" title={row.name}>
              <span className="line-clamp-2 break-words">{row.name}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function DiskDevicesByAvgList({
  items,
  emptyText,
  onItemClick,
  selectedName,
}: {
  items: DashboardDiskDeviceRank[]
  emptyText?: string
  onItemClick?: (hostname: string) => void
  selectedName?: string | null
}) {
  const t = useT()
  if (!items.length) {
    return (
      <p className="app-empty-state">
        {emptyText ?? t('dashboard.noData')}
      </p>
    )
  }
  return (
    <ul className="space-y-3.5">
      {items.map((row) => {
        const pct = Math.min(100, Math.round(row.avg_used_percent))
        const barTone =
          pct >= 92
            ? 'bg-[var(--color-primary)]'
            : pct >= 82
              ? 'bg-[var(--color-primary-hover)]'
              : pct >= 70
                ? 'bg-[var(--color-fg-muted)]'
                : 'bg-[var(--color-border-strong)]'
        const volLabel =
          row.volume_count === 1
            ? t('dashboard.volumeSingle')
            : t('dashboard.volumeMany', { count: row.volume_count })
        const isSelected = selectedName === row.hostname
        return (
          <li
            key={row.hostname}
            className={`rounded-xl px-3 py-2.5 transition app-legend-item ${
              isSelected ? 'app-legend-item--selected' : ''
            } ${onItemClick ? 'cursor-pointer' : ''}`}
            onClick={onItemClick ? () => onItemClick(row.hostname) : undefined}
            title={onItemClick ? t('dashboard.showComputerDetails') : undefined}
          >
            <div className="mb-1.5 flex justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="font-semibold text-[var(--color-fg)]">{row.hostname}</span>
                <span className="block truncate text-xs text-[var(--color-fg-subtle)]">
                  {volLabel}
                </span>
              </span>
              <span className="shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 py-0.5 font-mono text-sm font-semibold tabular-nums text-[var(--color-fg)]">
                {pct}%
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-[var(--color-border)]"
              title={t('dashboard.diskUsageTitle', { pct })}
            >
              <div
                className={`h-full rounded-full ${barTone} transition-all duration-500`}
                style={{ width: `${Math.max(4, pct)}%` }}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** Рейтинг без «чёрных полос»: номер строки, название, счётчик ПК. */
function RankedMetricList({
  items,
  emptyText,
  valueTitle,
  onItemClick,
  selectedName,
}: {
  items: { name: string; count: number }[]
  emptyText?: string
  valueTitle?: string
  onItemClick?: (name: string) => void
  selectedName?: string | null
}) {
  const t = useT()
  const effectiveValueTitle = valueTitle ?? t('dashboard.pcsValueTitle')
  if (!items.length) {
    return (
      <p className="app-empty-state">
        {emptyText ?? t('dashboard.noData')}
      </p>
    )
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {items.map((row, idx) => {
        const isSelected = selectedName === row.name
        return (
        <li
          key={`${row.name}-${idx}`}
          className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition app-legend-item sm:gap-3 sm:px-3 sm:py-2.5 ${
            isSelected ? 'app-legend-item--selected' : ''
          } ${onItemClick ? 'cursor-pointer' : ''}`}
          onClick={onItemClick ? () => onItemClick(row.name) : undefined}
          title={onItemClick ? t('dashboard.showPcList') : row.name}
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-muted)] font-mono text-[11px] font-bold text-[var(--color-fg-muted)]"
            aria-hidden
          >
            {idx + 1}
          </span>
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-fg)]"
            title={row.name}
          >
            {row.name}
          </span>
          <span
            className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-primary-muted)] px-2.5 py-1 font-mono text-xs font-semibold tabular-nums text-[var(--color-primary)]"
            title={`${effectiveValueTitle}: ${row.count}`}
          >
            {row.count}
          </span>
        </li>
        )
      })}
    </ul>
  )
}

function physicalDisksCount(items: { name: string; count: number }[], media: string) {
  return items.find((i) => i.name.toLowerCase() === media.toLowerCase())?.count ?? 0
}

function physicalDisksStatSub(items: { name: string; count: number }[], t: TranslateFn) {
  const ssd = physicalDisksCount(items, 'ssd')
  const hdd = physicalDisksCount(items, 'hdd')
  const parts: string[] = []
  if (ssd) parts.push(`${ssd} SSD`)
  if (hdd) parts.push(`${hdd} HDD`)
  return parts.length ? parts.join(` ${t('dashboard.and')} `) : null
}

function PhysicalDisksPanel({
  total,
  byVariant,
  onItemClick,
  selectedName,
}: {
  total: number
  byVariant: { name: string; count: number }[]
  onItemClick?: (name: string) => void
  selectedName?: string | null
}) {
  const t = useT()
  if (!total) {
    return (
      <p className="app-empty-state">
        {t('dashboard.physicalDisksEmptyBeforeModule')}{' '}
        <span className="font-medium">storage_health</span> {t('dashboard.physicalDisksEmptyAfterModule')}
      </p>
    )
  }

  return (
    <DonutDistribution
      items={byVariant}
      emptyText={t('dashboard.noData')}
      compact
      center
      svgSizePx={140}
      evenLegend
      onItemClick={onItemClick}
      selectedName={selectedName}
    />
  )
}

function MiniStatCard({
  label,
  value,
  sub,
  icon,
  accent,
  className = '',
}: {
  label: string
  value: string | number
  sub?: ReactNode
  icon: ReactNode
  accent: 'neutral' | 'brand'
  className?: string
}) {
  const isBrand = accent === 'brand'
  const iconWrap = isBrand
    ? 'border border-[var(--color-border)] bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
    : 'border border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'

  return (
    <div className={`app-panel transition-colors hover:border-[var(--color-border-strong)] ${className}`}>
      <div className="flex items-start gap-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconWrap}`}>{icon}</div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[11px] font-semibold leading-snug text-[var(--color-fg-subtle)]">{label}</div>
          <div className="admin-stat-value mt-3 text-[1.55rem] leading-none text-[var(--color-fg)] sm:text-[1.7rem]">{value}</div>
          {sub ? <div className="mt-2 text-[11px] font-medium leading-snug text-[var(--color-fg-subtle)]">{sub}</div> : null}
        </div>
      </div>
    </div>
  )
}

function SectionCard({
  title,
  description,
  children,
  className = '',
  action,
  dense,
  bodyClassName = '',
}: {
  title: string
  description?: string
  children: ReactNode
  className?: string
  action?: ReactNode
  dense?: boolean
  bodyClassName?: string
}) {
  const pad = dense ? '!p-4' : ''
  return (
    <div className={`app-panel transition-colors hover:border-[var(--color-border-strong)] ${pad} ${className}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[0.95rem] font-semibold tracking-tight text-[var(--color-fg)]">{title}</h2>
          {description ? (
            <p className="mt-2 max-w-prose text-xs leading-relaxed text-[var(--color-fg-subtle)]">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className={`${dense ? 'mt-4' : 'mt-5'} ${bodyClassName}`}>{children}</div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 app-stack-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((k) => (
          <div
            key={k}
            className="dashboard-skeleton-shimmer h-24 rounded-[1rem] bg-neutral-100 ring-1 ring-neutral-200/50 sm:h-[5.25rem]"
          />
        ))}
      </div>
      <div className="space-y-3">
        <div className="dashboard-skeleton-shimmer h-32 rounded-[1rem] ring-1 ring-neutral-200/50" />
        <div className="grid app-stack-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((k) => (
            <div key={k} className="dashboard-skeleton-shimmer h-56 rounded-[1rem] ring-1 ring-neutral-200/50" />
          ))}
        </div>
      </div>
    </div>
  )
}

export function DashboardPage() {
  const t = useT()
  const toast = useToast()
  const [data, setData] = useState<DashboardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [chartsMode, setChartsMode] = useState<DashboardChartsMode>(() => readChartsMode())
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
      if (e.key === DASHBOARD_MODE_KEY) setChartsMode(readChartsMode())
      if (e.key === DASHBOARD_WIDGETS_KEY) setWidgets(readWidgets())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div>
      <div className="app-panel mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
          <div className="page-hero-icon [&_svg]:!h-6 [&_svg]:!w-6">
            <IconDashboard className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="page-title !text-xl sm:!text-[1.4rem]">{t('titles.dashboard')}</h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
              {t('pages.dashboardSubtitle')}
            </p>
          </div>
        </div>
      </div>

      {loading ? (
        <DashboardSkeleton />
      ) : data ? (
        <div className="dashboard-enter space-y-5">
          {widgets['stat.computers_total'] ||
          widgets['stat.software_unique_titles'] ||
          widgets['stat.tags_in_directory'] ||
          widgets['stat.snmp_printers_total'] ||
          widgets['stat.physical_disks_total'] ? (
            <div className="grid grid-cols-2 app-stack-3 lg:grid-cols-5">
              {widgets['stat.computers_total'] ? (
                <MiniStatCard
                  label={t('dashboard.stats.computers.label')}
                  value={data.computers_total}
                  sub={t('dashboard.stats.computers.sub')}
                  icon={<IconPcs className="h-[18px] w-[18px]" />}
                  accent="brand"
                />
              ) : null}
              {widgets['stat.software_unique_titles'] ? (
                <MiniStatCard
                  label={t('dashboard.stats.softwareTitles.label')}
                  value={data.software_unique_titles}
                  sub={t('dashboard.stats.softwareTitles.sub')}
                  icon={<IconSoftware className="h-[18px] w-[18px]" />}
                  accent="neutral"
                />
              ) : null}
              {widgets['stat.tags_in_directory'] ? (
                <MiniStatCard
                  label={t('dashboard.stats.tags.label')}
                  value={data.tags_in_directory}
                  sub={t('dashboard.stats.tags.sub')}
                  icon={<IconTag className="h-[18px] w-[18px]" />}
                  accent="neutral"
                />
              ) : null}
              {widgets['stat.snmp_printers_total'] ? (
                <MiniStatCard
                  label={t('dashboard.stats.printers.label')}
                  value={data.snmp_printers_total}
                  sub={t('dashboard.stats.printers.sub')}
                  icon={<IconPrinter className="h-[18px] w-[18px]" />}
                  accent="neutral"
                />
              ) : null}
              {widgets['stat.physical_disks_total'] ? (() => {
                const disksBreakdown = physicalDisksStatSub(data.physical_disks_by_media, t)
                return (
                  <MiniStatCard
                    label={t('common.total')}
                    value={data.physical_disks_total}
                    sub={
                      <>
                        <span>{t('dashboard.stats.physicalDisks.sub')}</span>
                        {disksBreakdown ? <span className="mt-1 block">{disksBreakdown}</span> : null}
                      </>
                    }
                    icon={<IconDisk className="h-[18px] w-[18px]" />}
                    accent="neutral"
                  />
                )
              })() : null}
            </div>
          ) : null}

          <div className="space-y-4">
              <div className="flex flex-col gap-1 border-b border-neutral-200/70 pb-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
                <div>
                  <h2 className="text-base font-semibold tracking-tight text-[var(--color-fg)]">{t('dashboard.overview.title')}</h2>
                  <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                    {t('dashboard.overview.description')}
                  </p>
                </div>
              </div>
              {widgets['dist.by_os'] ||
              widgets['dist.by_manufacturer'] ||
              widgets['dist.ram_buckets'] ||
              widgets['dist.top_monitors'] ||
              widgets['dist.by_system_model'] ||
              widgets['dist.top_cpu'] ||
              widgets['dist.physical_disks'] ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {widgets['dist.by_os'] ? (
                    <SectionCard title={t('dashboard.sections.byOs.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution items={data.by_os} emptyText={t('dashboard.sections.byOs.empty')} {...drillChart('os', t('dashboard.sections.byOs.title'))} />
                      ) : (
                        <DonutDistribution
                          items={data.by_os}
                          emptyText={t('dashboard.sections.byOs.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('os', t('dashboard.sections.byOs.title'))}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.by_manufacturer'] ? (
                    <SectionCard title={t('dashboard.sections.byManufacturer.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution items={data.by_manufacturer} emptyText={t('dashboard.sections.byManufacturer.empty')} {...drillChart('manufacturer', t('dashboard.sections.byManufacturer.title'))} />
                      ) : (
                        <DonutDistribution
                          items={data.by_manufacturer}
                          emptyText={t('dashboard.sections.byManufacturer.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('manufacturer', t('dashboard.sections.byManufacturer.title'))}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.ram_buckets'] ? (
                    <SectionCard title={t('dashboard.sections.ram.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution
                          items={data.ram_buckets.map((b) => ({ name: b.label, count: b.count }))}
                          emptyText={t('dashboard.sections.ram.empty')}
                          {...drillChart('ram', t('dashboard.sections.ram.title'))}
                        />
                      ) : (
                        <DonutDistribution
                          items={data.ram_buckets.map((b) => ({ name: b.label, count: b.count }))}
                          emptyText={t('dashboard.sections.ram.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('ram', t('dashboard.sections.ram.title'))}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.top_monitors'] ? (
                    <SectionCard title={t('dashboard.sections.monitors.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution
                          items={data.top_monitors}
                          emptyText={t('dashboard.sections.monitors.empty')}
                          valueTitle={t('dashboard.pcsValueTitle')}
                          {...drillChart('monitor', t('dashboard.sections.monitors.title'))}
                        />
                      ) : (
                        <DonutDistribution
                          items={data.top_monitors}
                          emptyText={t('dashboard.sections.monitors.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('monitor', t('dashboard.sections.monitors.title'))}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.by_system_model'] ? (
                    <SectionCard
                      title={t('dashboard.sections.bySystemModel.title')}
                      dense
                      className="flex flex-col"
                      bodyClassName="flex flex-1 items-center justify-center"
                    >
                      {chartsMode === 'bars' ? (
                        <BarDistribution items={data.by_system_model} emptyText={t('dashboard.sections.bySystemModel.empty')} {...drillChart('system_model', t('dashboard.sections.bySystemModel.title'))} />
                      ) : (
                        <DonutDistribution
                          items={data.by_system_model}
                          emptyText={t('dashboard.sections.bySystemModel.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('system_model', t('dashboard.sections.bySystemModel.title'))}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.top_cpu'] ? (
                    <SectionCard title={t('dashboard.sections.cpu.title')} dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution
                          items={data.top_cpu.map((c) => ({ name: c.name, count: c.count }))}
                          emptyText={t('dashboard.sections.cpu.empty')}
                          {...drillChart('cpu', t('dashboard.sections.cpu.title'))}
                        />
                      ) : (
                        <DonutDistribution
                          items={data.top_cpu.map((c) => ({ name: c.name, count: c.count }))}
                          emptyText={t('dashboard.sections.cpu.empty')}
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('cpu', t('dashboard.sections.cpu.title'))}
                        />
                      )}
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

              {widgets['list.top_disk_devices'] ? (
                <SectionCard
                  title={t('dashboard.sections.localDisks.title')}
                  description={t('dashboard.sections.localDisks.description')}
                  dense
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
                  action={
                    <Link
                      to="/software"
                      className="shrink-0 rounded-xl border border-neutral-200/90 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50"
                    >
                      {t('dashboard.sections.topSoftware.action')}
                    </Link>
                  }
                >
                  <RankedMetricList
                    items={data.top_software}
                    emptyText={t('dashboard.sections.topSoftware.empty')}
                    {...drillChart('software', t('dashboard.sections.topSoftware.title'))}
                  />
                </SectionCard>
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
                                    : 'bg-neutral-50/50 ring-neutral-100 hover:bg-white hover:ring-neutral-200/80'
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
                                  <span className={`font-medium ${isSelected ? 'text-white' : 'text-neutral-700'}`}>
                                    {p.label}
                                  </span>
                                  <span
                                    className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-xs font-semibold ring-1 ${
                                      isSelected
                                        ? 'bg-white/10 text-white ring-white/20'
                                        : 'bg-white/90 text-neutral-900 ring-neutral-200/60'
                                    }`}
                                  >
                                    {p.pc_count}
                                  </span>
                                </div>
                                <div className="h-2 overflow-hidden rounded-full bg-neutral-200/50" title={tip}>
                                  <div
                                    className="h-full rounded-full bg-gradient-to-r from-blue-600 to-neutral-800"
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
