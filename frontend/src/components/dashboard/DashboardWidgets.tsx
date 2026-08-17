import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { DashboardDiskDeviceRank } from '../../api'
import { Skeleton } from '../Skeleton'
import { donutColorsForTheme } from '../../chartColors'
import { useT, useLocale } from '../../i18n/LocaleContext'
import { useTheme } from '../../ThemeContext'

type TranslateFn = ReturnType<typeof useT>

/** Короткие подписи в легенде дашборда (полное имя — в title). */
export function formatDashboardLabel(name: string): string {
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

export function DonutDistribution({
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

export function DiskDevicesByAvgList({
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
            <div className="mb-1.5 flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0">
                <span className="font-semibold text-[var(--color-fg)]">{row.hostname}</span>
                <span className="block truncate text-xs text-[var(--color-fg-subtle)]">
                  {volLabel}
                </span>
              </span>
              <span className="inline-flex h-7 min-w-[3.25rem] shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-2 font-mono text-xs font-semibold leading-none tabular-nums text-[var(--color-fg)]">
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
export function RankedMetricList({
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

export function PhysicalDisksPanel({
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
    return <p className="app-empty-state">{t('dashboard.physicalDisksEmpty')}</p>
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

export function formatAvgCloseHours(hours: number | null, t: TranslateFn): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) {
    return t('dashboard.stats.requestsAvgClose.empty')
  }
  if (hours < 1) {
    const m = Math.max(1, Math.round(hours * 60))
    return t('dashboard.stats.requestsAvgClose.minutes', { m: String(m) })
  }
  if (hours >= 48) {
    const d = Math.round((hours / 24) * 10) / 10
    return t('dashboard.stats.requestsAvgClose.days', { d: String(d) })
  }
  const h = Math.round(hours * 10) / 10
  return t('dashboard.stats.requestsAvgClose.hours', { h: String(h) })
}

export function formatSeriesDate(iso: string, granularity: string, locale: string): string {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  if (granularity === 'month') {
    return d.toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' })
  }
  if (granularity === 'week') {
    return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
  }
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' })
}

export function ClosedTicketsDynamicsChart({
  points,
  granularity,
  showTotal = true,
}: {
  points: { date: string; count: number; cumulative?: number }[]
  granularity: string
  showTotal?: boolean
}) {
  const t = useT()
  const { locale } = useLocale()
  const loc = locale === 'en' ? 'en-GB' : 'ru-RU'
  const [hover, setHover] = useState<number | null>(null)

  const w = 720
  const h = 168
  const pad = { top: 14, right: 14, bottom: 26, left: 34 }
  const plotW = w - pad.left - pad.right
  const plotH = h - pad.top - pad.bottom

  const maxCount = Math.max(1, ...points.map((p) => p.count))
  const totalClosed = points.length ? points[points.length - 1].cumulative ?? points.reduce((s, p) => s + p.count, 0) : 0

  const coords = useMemo(() => {
    if (!points.length) return [] as { x: number; y: number; i: number }[]
    const n = points.length
    return points.map((p, i) => {
      const x = pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
      const y = pad.top + plotH - (p.count / maxCount) * plotH
      return { x, y, i }
    })
  }, [points, maxCount, pad.left, pad.top, plotW, plotH])

  const linePath = useMemo(() => {
    if (coords.length === 0) return ''
    if (coords.length === 1) {
      const c = coords[0]
      return `M ${c.x - 8} ${c.y} L ${c.x + 8} ${c.y}`
    }
    return coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ')
  }, [coords])

  const areaPath = useMemo(() => {
    if (coords.length === 0) return ''
    const baseY = pad.top + plotH
    if (coords.length === 1) {
      const c = coords[0]
      return `M ${c.x - 10} ${baseY} L ${c.x - 10} ${c.y} L ${c.x + 10} ${c.y} L ${c.x + 10} ${baseY} Z`
    }
    const top = coords.map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ')
    const last = coords[coords.length - 1]
    const first = coords[0]
    return `${top} L ${last.x.toFixed(2)} ${baseY} L ${first.x.toFixed(2)} ${baseY} Z`
  }, [coords, pad.top, plotH])

  const xLabels = useMemo(() => {
    if (!points.length) return [] as number[]
    const n = points.length
    if (n <= 5) return points.map((_, i) => i)
    const mid = Math.floor((n - 1) / 2)
    return [0, mid, n - 1]
  }, [points])

  const yTicks = useMemo(() => {
    const top = maxCount
    if (top <= 3) return Array.from({ length: top + 1 }, (_, i) => i)
    return [0, Math.round(top / 2), top]
  }, [maxCount])

  const hoverPt = hover != null ? points[hover] : null
  const hoverCoord = hover != null ? coords[hover] : null

  if (!points.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 py-4 text-center">
        <div className="text-[12px] font-medium text-[var(--color-fg-muted)]">{t('dashboard.tickets.closedEmpty')}</div>
        <p className="max-w-[14rem] text-[10px] text-[var(--color-fg-subtle)]">{t('dashboard.tickets.closedEmptyHint')}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showTotal ? (
        <div className="mb-1 flex items-end">
          <div className="flex items-baseline gap-2">
            <span className="text-[1.1rem] font-semibold tabular-nums leading-none text-[var(--color-fg)]">{totalClosed}</span>
            <span className="text-[9px] font-medium text-[var(--color-fg-subtle)]">{t('dashboard.tickets.closedTotal')}</span>
          </div>
        </div>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          className="h-full w-full min-h-[10.5rem]"
          role="img"
          aria-label={t('dashboard.tickets.closedDynamics')}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="closedTicketsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.34" />
              <stop offset="55%" stopColor="var(--color-primary)" stopOpacity="0.1" />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0" />
            </linearGradient>
            <linearGradient id="closedTicketsStroke" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.55" />
              <stop offset="50%" stopColor="var(--color-primary)" stopOpacity="1" />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.7" />
            </linearGradient>
          </defs>

          {yTicks.map((tick) => {
            const y = pad.top + plotH - (tick / maxCount) * plotH
            return (
              <g key={`y-${tick}`}>
                <line
                  x1={pad.left}
                  y1={y}
                  x2={pad.left + plotW}
                  y2={y}
                  stroke="var(--color-border)"
                  strokeOpacity={tick === 0 ? 0.9 : 0.45}
                  strokeDasharray={tick === 0 ? undefined : '3 4'}
                />
                <text
                  x={pad.left - 8}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-[var(--color-fg-subtle)]"
                  style={{ fontSize: 10, fontWeight: 600 }}
                >
                  {tick}
                </text>
              </g>
            )
          })}

          <path d={areaPath} fill="url(#closedTicketsFill)" />
          <path
            d={linePath}
            fill="none"
            stroke="url(#closedTicketsStroke)"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {coords.map((c) => (
            <circle
              key={`pt-${c.i}`}
              cx={c.x}
              cy={c.y}
              r={hover === c.i ? 4.5 : points[c.i].count > 0 ? 2.6 : 0}
              fill="var(--color-surface)"
              stroke="var(--color-primary)"
              strokeWidth={hover === c.i ? 2.2 : 1.6}
              opacity={points[c.i].count > 0 || hover === c.i ? 1 : 0}
              style={{ transition: 'r 120ms ease' }}
            />
          ))}

          {hoverCoord ? (
            <line
              x1={hoverCoord.x}
              y1={pad.top}
              x2={hoverCoord.x}
              y2={pad.top + plotH}
              stroke="var(--color-primary)"
              strokeOpacity={0.35}
              strokeWidth={1.25}
              strokeDasharray="3 3"
            />
          ) : null}

          {xLabels.map((i) => {
            const c = coords[i]
            if (!c) return null
            return (
              <text
                key={`x-${i}`}
                x={c.x}
                y={h - 8}
                textAnchor="middle"
                className="fill-[var(--color-fg-subtle)]"
                style={{ fontSize: 8, fontWeight: 600 }}
              >
                {formatSeriesDate(points[i].date, granularity, loc)}
              </text>
            )
          })}

          {coords.map((c) => {
            const band = points.length <= 1 ? plotW : plotW / Math.max(1, points.length - 1)
            return (
              <rect
                key={`hit-${c.i}`}
                x={c.x - band / 2}
                y={pad.top}
                width={Math.max(band, 12)}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(c.i)}
              />
            )
          })}
        </svg>

        {hoverPt && hoverCoord ? (
          <div
            className="pointer-events-none absolute z-10 min-w-[7.5rem] -translate-x-1/2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 shadow-lg"
            style={{
              left: `${(hoverCoord.x / w) * 100}%`,
              top: `${Math.max(4, (hoverCoord.y / h) * 100 - 18)}%`,
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {formatSeriesDate(hoverPt.date, granularity, loc)}
            </div>
            <div className="mt-0.5 text-[13px] font-semibold tabular-nums text-[var(--color-fg)]">
              {t('dashboard.tickets.closedInPeriod', { n: String(hoverPt.count) })}
            </div>
            <div className="text-[10px] text-[var(--color-fg-muted)]">
              {t('dashboard.tickets.closedCumulative', { n: String(hoverPt.cumulative ?? 0) })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function MiniStatCard({
  label,
  value,
  sub,
  icon,
  className = '',
  to,
}: {
  label: string
  value: string | number
  sub?: ReactNode
  icon: ReactNode
  className?: string
  to?: string
}) {
  const body = (
    <div className={`app-panel h-full !rounded-xl !px-2.5 !py-2 transition-colors hover:border-[var(--color-border-strong)] ${className}`}>
      <div className="flex items-start gap-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-primary)_10%,var(--color-surface))] text-[var(--color-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[9px] font-semibold uppercase tracking-[0.05em] text-[var(--color-fg-subtle)]">{label}</div>
          <div className="mt-0.5 text-[1.2rem] font-semibold leading-none tabular-nums text-[var(--color-fg)]">{value}</div>
          {sub ? <div className="mt-0.5 truncate text-[9px] font-medium leading-snug text-[var(--color-fg-subtle)]">{sub}</div> : null}
        </div>
      </div>
    </div>
  )
  if (to) {
    return (
      <Link to={to} className="block h-full rounded-[inherit] no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]">
        {body}
      </Link>
    )
  }
  return body
}

export function SectionCard({
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
          <h2 className="text-[0.95rem] font-medium tracking-tight text-[var(--color-fg)]">{title}</h2>
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

export function DashboardSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-busy="true">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <Skeleton key={k} className="h-[4.25rem] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)]">
        <Skeleton className="h-44 rounded-[1rem]" />
        <Skeleton className="h-44 rounded-[1rem]" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <Skeleton key={k} className="h-56 rounded-[1rem]" />
        ))}
      </div>
    </div>
  )
}
