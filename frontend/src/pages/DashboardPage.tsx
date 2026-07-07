import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, type DashboardDiskDeviceRank, type DashboardSegmentKind, type DashboardSummary } from '../api'
import { DashboardDrilldownPanel, type DashboardDrilldownSelection } from '../components/DashboardDrilldown'
import { IconDashboard, IconDisk, IconPcs, IconPrinter, IconSoftware, IconTag } from '../components/icons'

/** Согласованная палитра для кольцевых диаграмм (нейтральная база + акцент бренда) */
const DONUT_COLORS = [
  '#dc2626',
  '#18181b',
  '#3f3f46',
  '#71717a',
  '#b91c1c',
  '#52525b',
  '#a1a1aa',
  '#e4e4e7',
  '#991b1b',
  '#27272a',
  '#d4d4d8',
  '#78716c',
]

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
        color: DONUT_COLORS[i % DONUT_COLORS.length],
      }
    })
  }, [normalizedItems, total])

  const clickable = Boolean(onItemClick)

  if (!normalizedItems.length || total <= 0) {
    return (
      <p className="rounded-2xl border border-dashed border-neutral-200/90 bg-gradient-to-b from-neutral-50/90 to-white px-4 py-10 text-center text-sm text-neutral-500">
        {emptyText ?? 'Нет данных'}
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
          className="drop-shadow-[0_12px_32px_-8px_rgb(15_23_42_/_0.12)]"
          role="img"
          aria-label="Круговая диаграмма распределения"
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
                stroke="rgb(255 255 255 / 0.92)"
                strokeWidth={active ? 1.75 : 1.25}
                strokeLinejoin="round"
                className={clickable ? 'cursor-pointer' : undefined}
                style={{
                  opacity: dim ? 0.42 : 1,
                  transition: 'opacity 100ms ease-out',
                }}
                onMouseEnter={() => setHovered(s.i)}
                onClick={clickable ? () => onItemClick?.(s.item.name) : undefined}
                aria-label={clickable ? `Показать ПК: ${s.item.name}` : undefined}
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
              className={`admin-stat-value leading-none tracking-tight text-neutral-950 ${compact ? 'text-[1.35rem]' : 'text-[1.65rem]'}`}
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
                className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-0.5 rounded-md px-1.5 py-1 text-xs transition-colors duration-150 ${
                  clickable ? 'cursor-pointer' : 'cursor-default'
                } ${
                  isSelected
                    ? 'bg-neutral-950 text-white ring-1 ring-neutral-950'
                    : hovered === i
                      ? 'bg-white ring-1 ring-neutral-200/70'
                      : 'hover:bg-neutral-50/90'
                }`}
                style={{ opacity: rowDim ? 0.55 : 1 }}
                title={clickable ? `${row.name} — нажмите для списка ПК` : row.name}
                onMouseEnter={() => setHovered(i)}
                onClick={clickable ? legendClick : undefined}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-sm ring-1 ring-neutral-200/60"
                  style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
                />
                <span
                  className={`min-w-0 truncate font-medium leading-tight ${
                    isSelected ? 'text-white' : 'text-neutral-700'
                  }`}
                >
                  {label}
                </span>
                <span
                  className={`font-mono text-xs font-semibold tabular-nums ${
                    isSelected ? 'text-white' : 'text-neutral-900'
                  }`}
                >
                  {row.count}
                </span>
                <span className={`text-[10px] tabular-nums ${isSelected ? 'text-white/70' : 'text-neutral-400'}`}>
                  ({pct}%)
                </span>
              </li>
            )
          }
          return (
            <li
              key={row.name}
              className={`flex items-center gap-3 rounded-xl transition-all duration-150 ${
                clickable ? 'cursor-pointer' : 'cursor-default'
              } ${
                isSelected
                  ? 'bg-neutral-950 text-white shadow-sm ring-1 ring-neutral-950'
                  : hovered === i
                    ? 'bg-white shadow-sm ring-1 ring-neutral-200/80'
                    : 'hover:bg-neutral-50/90'
              } ${tallLegend ? 'px-2.5 py-2.5 text-[15px]' : 'px-2 py-1.5 text-sm'}`}
              style={{ opacity: rowDim ? 0.55 : 1 }}
              title={clickable ? `${row.name} — нажмите для списка ПК` : row.name}
              onMouseEnter={() => setHovered(i)}
              onClick={clickable ? legendClick : undefined}
            >
              <span
                className={`${tallLegend ? 'h-3 w-3' : 'mt-0.5 h-2.5 w-2.5'} shrink-0 rounded-sm shadow-sm ring-1 ring-neutral-200/60`}
                style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }}
              />
              <span
                className={`min-w-0 flex-1 break-words text-[13px] font-medium leading-snug ${
                  isSelected ? 'text-white' : 'text-neutral-700'
                }`}
              >
                {row.name}
              </span>
              <span
                className={`shrink-0 font-mono font-semibold ${isSelected ? 'text-white' : 'text-neutral-900'} ${
                  tallLegend ? 'text-base' : 'text-sm'
                }`}
              >
                {row.count}
              </span>
              <span
                className={`shrink-0 tabular-nums ${isSelected ? 'text-white/70' : 'text-neutral-400'} ${
                  tallLegend ? 'text-sm' : 'text-xs'
                }`}
              >
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
  valueTitle = 'ПК',
  onItemClick,
  selectedName,
}: {
  items: { name: string; count: number }[]
  emptyText?: string
  valueTitle?: string
  onItemClick?: (name: string) => void
  selectedName?: string | null
}) {
  const normalizedItems = useMemo(() => items.filter((i) => i.count > 0), [items])
  const max = useMemo(() => normalizedItems.reduce((m, i) => Math.max(m, i.count), 0), [normalizedItems])
  if (!normalizedItems.length || max <= 0) {
    return (
      <p className="rounded-2xl border border-dashed border-neutral-200/90 bg-gradient-to-b from-neutral-50/90 to-white px-4 py-10 text-center text-sm text-neutral-500">
        {emptyText ?? 'Нет данных'}
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
          ? `${row.name}: ${valueTitle} ${row.count} — нажмите для списка`
          : `${row.name}: ${valueTitle} ${row.count}`
        const isSelected = selectedName === row.name
        return (
          <div key={`${row.name}-${idx}`} className="min-w-0 flex-1">
            <div
              className={`group relative h-36 overflow-hidden rounded-2xl bg-gradient-to-b from-neutral-100/90 to-neutral-50/80 shadow-inner ring-1 transition ${
                isSelected
                  ? 'ring-neutral-900'
                  : 'ring-neutral-200/60 group-hover:ring-neutral-300/70'
              } ${clickable ? 'cursor-pointer' : ''}`}
              title={tip}
              aria-label={tip}
              onClick={clickable ? () => onItemClick?.(row.name) : undefined}
            >
              <div
                className="absolute inset-x-0 bottom-0 rounded-t-xl bg-gradient-to-t from-red-700 via-neutral-800 to-neutral-600 opacity-95 shadow-[0_-4px_16px_-4px_rgb(0_0_0/0.15)] transition-[height] duration-300 ease-out group-hover:opacity-100"
                style={{ height: `${Math.max(6, pct)}%` }}
              />
              <div className="absolute inset-x-0 top-2 px-1.5 text-center font-mono text-[11px] font-semibold tabular-nums text-neutral-900 drop-shadow-sm">
                {row.count}
              </div>
            </div>
            <div className="mt-2 text-center text-[11px] font-medium leading-snug text-neutral-600" title={row.name}>
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
  if (!items.length) {
    return (
      <p className="rounded-2xl border border-dashed border-neutral-200/90 bg-gradient-to-b from-neutral-50/90 to-white px-4 py-10 text-center text-sm text-neutral-500">
        {emptyText ?? 'Нет данных'}
      </p>
    )
  }
  return (
    <ul className="space-y-3.5">
      {items.map((row) => {
        const pct = Math.min(100, Math.round(row.avg_used_percent))
        const barTone =
          pct >= 92
            ? 'from-neutral-950 via-red-950 to-red-500'
            : pct >= 82
              ? 'from-neutral-950 via-neutral-900 to-red-700'
              : pct >= 70
                ? 'from-neutral-900 to-neutral-950'
                : 'from-neutral-800 to-black'
        const volLabel =
          row.volume_count === 1 ? '1 локальный том' : `${row.volume_count} локальных томов`
        const isSelected = selectedName === row.hostname
        return (
          <li
            key={row.hostname}
            className={`rounded-xl px-3 py-2.5 ring-1 transition ${
              isSelected
                ? 'bg-neutral-950 text-white ring-neutral-950'
                : 'bg-neutral-50/50 ring-neutral-100 hover:bg-white hover:ring-neutral-200/80'
            } ${onItemClick ? 'cursor-pointer' : ''}`}
            onClick={onItemClick ? () => onItemClick(row.hostname) : undefined}
            title={onItemClick ? 'Нажмите, чтобы показать сведения о ПК' : undefined}
          >
            <div className="mb-1.5 flex justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className={`font-semibold ${isSelected ? 'text-white' : 'text-neutral-800'}`}>{row.hostname}</span>
                <span className={`block truncate text-xs ${isSelected ? 'text-white/70' : 'text-neutral-500'}`}>
                  {volLabel}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-md px-2 py-0.5 font-mono text-sm font-semibold tabular-nums ring-1 ${
                  isSelected
                    ? 'bg-white/10 text-white ring-white/20'
                    : 'bg-white/80 text-neutral-900 ring-neutral-200/60'
                }`}
              >
                {pct}%
              </span>
            </div>
            <div
              className="h-2 overflow-hidden rounded-full bg-neutral-200/60"
              title={`Заполнено ${pct}% (по объёму дисков)`}
            >
              <div
                className={`h-full rounded-full bg-gradient-to-r ${barTone} shadow-sm transition-all duration-500`}
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
  valueTitle = 'ПК',
  onItemClick,
  selectedName,
}: {
  items: { name: string; count: number }[]
  emptyText?: string
  valueTitle?: string
  onItemClick?: (name: string) => void
  selectedName?: string | null
}) {
  if (!items.length) {
    return (
      <p className="rounded-2xl border border-dashed border-neutral-200/90 bg-gradient-to-b from-neutral-50/90 to-white px-4 py-10 text-center text-sm text-neutral-500">
        {emptyText ?? 'Нет данных'}
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
          className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 ring-1 transition sm:gap-3 sm:px-3 sm:py-2.5 ${
            isSelected
              ? 'bg-neutral-950 ring-neutral-950'
              : 'bg-neutral-50/60 ring-neutral-100 hover:bg-white hover:shadow-sm hover:ring-neutral-200/70'
          } ${onItemClick ? 'cursor-pointer' : ''}`}
          onClick={onItemClick ? () => onItemClick(row.name) : undefined}
          title={onItemClick ? 'Нажмите, чтобы показать список ПК' : row.name}
        >
          <span
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-mono text-[11px] font-bold shadow-inner ${
              isSelected
                ? 'bg-white/10 text-white'
                : 'bg-gradient-to-br from-neutral-200/80 to-neutral-100 text-neutral-600'
            }`}
            aria-hidden
          >
            {idx + 1}
          </span>
          <span
            className={`min-w-0 flex-1 truncate text-sm font-medium ${isSelected ? 'text-white' : 'text-neutral-800'}`}
            title={row.name}
          >
            {row.name}
          </span>
          <span
            className={`shrink-0 rounded-lg px-2.5 py-1 font-mono text-xs font-semibold tabular-nums shadow-sm ${
              isSelected ? 'bg-white/10 text-white' : 'bg-neutral-900 text-white'
            }`}
            title={`${valueTitle}: ${row.count}`}
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

function physicalDisksStatSub(items: { name: string; count: number }[]) {
  const ssd = physicalDisksCount(items, 'ssd')
  const hdd = physicalDisksCount(items, 'hdd')
  const parts: string[] = []
  if (ssd) parts.push(`${ssd} SSD`)
  if (hdd) parts.push(`${hdd} HDD`)
  return parts.length ? parts.join(' и ') : null
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
  if (!total) {
    return (
      <p className="rounded-2xl border border-dashed border-neutral-200/90 bg-gradient-to-b from-neutral-50/90 to-white px-4 py-10 text-center text-sm text-neutral-500">
        Нет данных по физическим дискам — включите модуль <span className="font-medium">storage_health</span> в агенте и
        обновите отчёты.
      </p>
    )
  }

  return (
    <DonutDistribution
      items={byVariant}
      emptyText="Нет данных"
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
    ? 'border border-red-100 bg-red-50 text-red-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.78)]'
    : 'border border-neutral-100 bg-neutral-50 text-neutral-700 shadow-[inset_0_1px_0_rgb(255_255_255/0.82)]'

  return (
    <div
      className={`group relative overflow-hidden rounded-[1.15rem] border border-neutral-200/70 bg-white p-5 shadow-[0_16px_40px_-32px_rgb(15_23_42/0.5),0_1px_2px_rgb(15_23_42/0.04)] transition duration-200 hover:-translate-y-0.5 hover:border-neutral-300/80 hover:shadow-[0_24px_60px_-38px_rgb(15_23_42/0.55),0_1px_2px_rgb(15_23_42/0.04)] ${className}`}
    >
      <div
        className={`pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full blur-2xl transition-opacity duration-300 group-hover:opacity-100 ${
          isBrand ? 'bg-red-100/70 opacity-80' : 'bg-neutral-200/70 opacity-60'
        }`}
        aria-hidden
      />
      {isBrand ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-red-500/35 to-transparent"
          aria-hidden
        />
      ) : (
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neutral-300/40 to-transparent"
          aria-hidden
        />
      )}
      <div className="relative flex items-start gap-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconWrap}`}>{icon}</div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="text-[11px] font-semibold leading-snug text-neutral-500">{label}</div>
          <div className="admin-stat-value mt-5 text-[1.55rem] leading-none text-neutral-950 sm:text-[1.7rem]">{value}</div>
          {sub ? <div className="mt-2 text-[11px] font-medium leading-snug text-neutral-500">{sub}</div> : null}
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
  const pad = dense ? 'p-4 sm:p-4' : 'p-5 sm:p-6'
  return (
    <div
      className={`group relative overflow-hidden rounded-[1.15rem] border border-neutral-200/70 bg-white ${pad} shadow-[0_16px_44px_-34px_rgb(15_23_42/0.48),0_1px_2px_rgb(15_23_42/0.04)] transition duration-200 hover:border-neutral-300/80 hover:shadow-[0_24px_62px_-40px_rgb(15_23_42/0.52),0_1px_2px_rgb(15_23_42/0.04)] ${className}`}
    >
      <div
        className="pointer-events-none absolute -right-20 -top-20 h-44 w-44 rounded-full bg-red-50/80 blur-3xl transition-opacity group-hover:opacity-100"
        aria-hidden
      />
      <div className="relative flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[0.95rem] font-semibold tracking-tight text-neutral-950">{title}</h2>
          {description ? (
            <p className="mt-2 max-w-prose text-xs leading-relaxed text-neutral-500">{description}</p>
          ) : null}
        </div>
        {action}
      </div>
      <div className={`relative ${dense ? 'mt-4' : 'mt-5'} ${bodyClassName}`}>{children}</div>
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
  const [data, setData] = useState<DashboardSummary | null>(null)
  const [err, setErr] = useState<string | null>(null)
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
    setErr(null)
    try {
      setData(await api.dashboardSummary())
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

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
      <div className="relative mb-6 overflow-hidden rounded-[1rem] border border-neutral-200/70 bg-white px-4 py-5 shadow-[0_18px_50px_-38px_rgb(15_23_42/0.55),0_1px_2px_rgb(15_23_42/0.04)] sm:px-6 sm:py-6">
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-red-100 bg-red-50 text-red-600 shadow-[inset_0_1px_0_rgb(255_255_255/0.82)] [&_svg]:!h-6 [&_svg]:!w-6">
            <IconDashboard className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="page-title !text-xl sm:!text-[1.4rem]">Дашборд</h1>
            <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-neutral-600">
              Парк машин: распределение ОС и железа, заполненность дисков и топы по ПО и периферии.
            </p>
          </div>
        </div>
      </div>

      {err && (
        <div className="app-alert app-alert-error mb-6 shadow-sm">
          {err}
        </div>
      )}

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
                  label="Рабочих станций"
                  value={data.computers_total}
                  sub="в инвентаризации"
                  icon={<IconPcs className="h-[18px] w-[18px]" />}
                  accent="brand"
                />
              ) : null}
              {widgets['stat.software_unique_titles'] ? (
                <MiniStatCard
                  label="Названий ПО"
                  value={data.software_unique_titles}
                  sub="уникальных в каталоге"
                  icon={<IconSoftware className="h-[18px] w-[18px]" />}
                  accent="neutral"
                />
              ) : null}
              {widgets['stat.tags_in_directory'] ? (
                <MiniStatCard
                  label="Тегов"
                  value={data.tags_in_directory}
                  sub="в справочнике"
                  icon={<IconTag className="h-[18px] w-[18px]" />}
                  accent="neutral"
                />
              ) : null}
              {widgets['stat.snmp_printers_total'] ? (
                <MiniStatCard
                  label="Принтеры"
                  value={data.snmp_printers_total}
                  sub="SNMP в инвентаризации"
                  icon={<IconPrinter className="h-[18px] w-[18px]" />}
                  accent="neutral"
                />
              ) : null}
              {widgets['stat.physical_disks_total'] ? (() => {
                const disksBreakdown = physicalDisksStatSub(data.physical_disks_by_media)
                return (
                  <MiniStatCard
                    label="Всего"
                    value={data.physical_disks_total}
                    sub={
                      <>
                        <span>физических дисков</span>
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
                  <h2 className="text-base font-semibold tracking-tight text-neutral-950">Распределение и нагрузка</h2>
                  <p className="mt-1 text-xs text-neutral-500">
                    Диаграммы по данным агентов; клик по сегменту — список ПК с ОС, дисками и железом.
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
                    <SectionCard title="Операционные системы" dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution items={data.by_os} emptyText="Нет ПК в базе" {...drillChart('os', 'Операционные системы')} />
                      ) : (
                        <DonutDistribution
                          items={data.by_os}
                          emptyText="Нет ПК в базе"
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('os', 'Операционные системы')}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.by_manufacturer'] ? (
                    <SectionCard title="Производители (OEM)" dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution items={data.by_manufacturer} emptyText="Нет данных" {...drillChart('manufacturer', 'Производители (OEM)')} />
                      ) : (
                        <DonutDistribution
                          items={data.by_manufacturer}
                          emptyText="Нет данных"
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('manufacturer', 'Производители (OEM)')}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.ram_buckets'] ? (
                    <SectionCard title="Оперативная память" dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution
                          items={data.ram_buckets.map((b) => ({ name: b.label, count: b.count }))}
                          emptyText="Нет данных"
                          {...drillChart('ram', 'Оперативная память')}
                        />
                      ) : (
                        <DonutDistribution
                          items={data.ram_buckets.map((b) => ({ name: b.label, count: b.count }))}
                          emptyText="Нет данных"
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('ram', 'Оперативная память')}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.top_monitors'] ? (
                    <SectionCard title="Мониторы" dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution
                          items={data.top_monitors}
                          emptyText="Нет строк мониторов. Обновите агент и проверьте PnP."
                          valueTitle="ПК"
                          {...drillChart('monitor', 'Мониторы')}
                        />
                      ) : (
                        <DonutDistribution
                          items={data.top_monitors}
                          emptyText="Нет строк мониторов. Обновите агент и проверьте PnP."
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('monitor', 'Мониторы')}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.by_system_model'] ? (
                    <SectionCard
                      title="Модели (WMI)"
                      dense
                      className="flex flex-col"
                      bodyClassName="flex flex-1 items-center justify-center"
                    >
                      {chartsMode === 'bars' ? (
                        <BarDistribution items={data.by_system_model} emptyText="Нет данных" {...drillChart('system_model', 'Модели (WMI)')} />
                      ) : (
                        <DonutDistribution
                          items={data.by_system_model}
                          emptyText="Нет данных"
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('system_model', 'Модели (WMI)')}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.top_cpu'] ? (
                    <SectionCard title="Процессоры" dense className="flex flex-col" bodyClassName="flex flex-1 items-center justify-center">
                      {chartsMode === 'bars' ? (
                        <BarDistribution
                          items={data.top_cpu.map((c) => ({ name: c.name, count: c.count }))}
                          emptyText="Нет данных по CPU"
                          {...drillChart('cpu', 'Процессоры')}
                        />
                      ) : (
                        <DonutDistribution
                          items={data.top_cpu.map((c) => ({ name: c.name, count: c.count }))}
                          emptyText="Нет данных по CPU"
                          compact
                          center
                          svgSizePx={132}
                          evenLegend
                          {...drillChart('cpu', 'Процессоры')}
                        />
                      )}
                    </SectionCard>
                  ) : null}
                  {widgets['dist.physical_disks'] ? (
                    <SectionCard
                      title="Физические диски"
                      description="SSD/HDD (агент v3) и тома C:/D: (агент v2) — единая диаграмма."
                      dense
                      className="flex flex-col"
                      bodyClassName="flex flex-1 items-center justify-center"
                    >
                      <PhysicalDisksPanel
                        total={data.physical_disks_total}
                        byVariant={data.physical_disks_by_variant}
                        {...drillChart('physical_disk', 'Физические диски')}
                      />
                    </SectionCard>
                  ) : null}
                </div>
              ) : null}

              {widgets['list.top_disk_devices'] ? (
                <SectionCard
                  title="Локальные диски"
                  description="Топ 10 ПК по заполненности томов (по объёму в отчёте агента)."
                  dense
                >
                  <DiskDevicesByAvgList
                    items={data.top_disk_devices}
                    emptyText="Нет данных по дискам — в отчёте нужен блок disks."
                    {...drillChart('hostname', 'Локальные диски')}
                  />
                </SectionCard>
              ) : null}

              {widgets['list.top_software'] ? (
                <SectionCard
                  title="Топ установленного ПО"
                  description="По числу ПК с пакетом в реестре."
                  dense
                  action={
                    <Link
                      to="/software"
                      className="shrink-0 rounded-xl border border-neutral-200/90 bg-white px-3.5 py-2 text-xs font-semibold text-neutral-800 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50"
                    >
                      Каталог ПО →
                    </Link>
                  }
                >
                  <RankedMetricList
                    items={data.top_software}
                    emptyText="Нет данных — отправьте отчёты агента"
                    {...drillChart('software', 'Топ установленного ПО')}
                  />
                </SectionCard>
              ) : null}

              {widgets['list.peripheral_kinds'] || widgets['list.top_peripherals'] ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  {widgets['list.peripheral_kinds'] ? (
                    <SectionCard
                      title="Периферия по категориям"
                      description="ПК с хотя бы одним устройством класса PnP."
                      dense
                    >
                      {!data.peripheral_kinds.length ? (
                        <p className="rounded-2xl border border-dashed border-neutral-200/90 bg-gradient-to-b from-neutral-50/90 to-white px-4 py-10 text-center text-sm text-neutral-500">
                          Нет данных — обновите агент.
                        </p>
                      ) : (
                        <ul className="space-y-3 text-sm">
                          {data.peripheral_kinds.map((p) => {
                            const pct = Math.round((p.pc_count / Math.max(1, data.computers_total)) * 100)
                            const tip = `${p.label}: ${p.pc_count} ПК (${pct}%)`
                            const isSelected =
                              drilldown?.kind === 'peripheral_kind' &&
                              drilldown.chartTitle === 'Периферия по категориям' &&
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
                                    chartTitle: 'Периферия по категориям',
                                    displayName: p.label,
                                  })
                                }
                                title="Нажмите, чтобы показать список ПК"
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
                                    className="h-full rounded-full bg-gradient-to-r from-red-600 to-neutral-800"
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
                    <SectionCard title="Частые устройства (PnP)" dense>
                      <RankedMetricList
                        items={data.top_peripherals}
                        emptyText="Нет периферии в базе"
                        {...drillChart('peripheral', 'Частые устройства (PnP)')}
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
