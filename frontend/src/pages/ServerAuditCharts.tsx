import {
  Chart as ChartJS,
  Filler,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { useMemo } from 'react'
import { Line } from 'react-chartjs-2'

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

export type AuditSeries = {
  label: string
  color: string
  data: Array<number | null>
}

type Props = {
  times: string[]
  series: AuditSeries[]
  unit?: 'temp' | 'percent' | 'rate' | 'load'
  locale: string
  hoverMs: number | null
  onHover: (ms: number | null) => void
  threshold?: number
}

function themeColor(name: string, fallback: string) {
  if (typeof document === 'undefined') return fallback
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

function tick(unit: Props['unit'], value: number) {
  if (!Number.isFinite(value)) return ''
  if (unit === 'percent') return `${Math.round(value)}%`
  if (unit === 'temp') return `${Math.round(value)}°`
  if (unit === 'rate') {
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`
    if (value >= 1024) return `${Math.round(value / 1024)} KB/s`
    return `${Math.round(value)} B/s`
  }
  return value >= 10 ? value.toFixed(0) : value.toFixed(1)
}

function fmtWhen(ms: number, span: number, locale: string, withSeconds = false) {
  const date = new Date(ms)
  const loc = locale === 'en' ? 'en-US' : 'ru-RU'
  if (!Number.isFinite(date.getTime())) return ''
  if (span <= 36 * 3600 * 1000) {
    return date.toLocaleTimeString(loc, {
      hour: '2-digit',
      minute: '2-digit',
      second: withSeconds ? '2-digit' : undefined,
    })
  }
  return date.toLocaleString(loc, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function steps(times: number[]) {
  const deltas: number[] = []
  for (let index = 1; index < times.length; index += 1) {
    const delta = times[index] - times[index - 1]
    if (delta > 0) deltas.push(delta)
  }
  deltas.sort((a, b) => a - b)
  return deltas
}

function yExtent(unit: Props['unit'], series: AuditSeries[]) {
  const nums: number[] = []
  for (const item of series) {
    for (const value of item.data) {
      if (value != null && !Number.isNaN(value)) nums.push(value)
    }
  }
  if (nums.length === 0) {
    return unit === 'percent' ? { min: 0, max: 100 } : { min: 0, max: 1 }
  }
  const lo = Math.min(...nums)
  const hi = Math.max(...nums)
  const spread = hi - lo
  if (unit === 'percent') {
    const pad = Math.max(spread * 0.25, 2)
    return { min: 0, max: Math.min(100, Math.max(8, hi + pad)) }
  }
  if (unit === 'temp') {
    const pad = Math.max(spread * 0.2, 2)
    return { min: Math.max(0, lo - pad), max: hi + pad }
  }
  if (unit === 'rate') {
    const pad = Math.max(spread * 0.2, hi * 0.08, 1)
    return { min: 0, max: hi + pad }
  }
  const pad = Math.max(spread * 0.25, 0.05)
  return { min: 0, max: Math.max(hi + pad, 0.2) }
}

function withGaps(times: number[], data: Array<number | null>, limit: number) {
  const points: Array<{ x: number; y: number | null }> = []
  times.forEach((time, index) => {
    const previous = points[points.length - 1]
    if (previous && time - previous.x > limit) points.push({ x: previous.x + 1, y: null })
    const value = data[index]
    points.push({ x: time, y: value == null || Number.isNaN(value) ? null : value })
  })
  return points
}

type GuideChart = {
  ctx: CanvasRenderingContext2D
  chartArea?: { left: number; right: number; top: number; bottom: number }
  scales: {
    x?: { getPixelForValue: (value: number) => number }
    y?: { getPixelForValue: (value: number) => number }
  }
}

export function ServerAuditCharts({ times, series, unit, locale, hoverMs, onHover, threshold }: Props) {
  const stamps = useMemo(
    () => times.map((iso) => new Date(iso).getTime()).filter((value) => Number.isFinite(value)),
    [times],
  )
  const aligned = stamps.length === times.length ? stamps : times.map((iso) => new Date(iso).getTime())
  const span = aligned.length > 1 ? aligned[aligned.length - 1] - aligned[0] : 0
  const deltas = steps(aligned)
  const median = deltas[Math.floor(deltas.length / 2)] ?? 0
  // A missed 15s sample is not a hole. Break the line only after a few quiet minutes.
  const limit = deltas.length === 0 ? Number.POSITIVE_INFINITY : Math.max(median * 8, 3 * 60 * 1000)
  const precise = median > 0 && median < 60_000
  const y = yExtent(unit, series)
  const muted = themeColor('--color-fg-subtle', '#6b7280')
  const grid = themeColor('--color-border', '#e8ebf0')
  const surface = themeColor('--color-surface', '#ffffff')
  const fg = themeColor('--color-fg', '#111827')

  const guide = useMemo(
    () => ({
      id: 'auditGuide',
      afterDatasetsDraw(chart: GuideChart) {
        const { ctx, chartArea, scales } = chart
        if (!chartArea) return
        ctx.save()
        if (threshold != null && scales.y) {
          const y = scales.y.getPixelForValue(threshold)
          if (y >= chartArea.top && y <= chartArea.bottom) {
            ctx.beginPath()
            ctx.strokeStyle = themeColor('--color-fg-subtle', '#6b7280')
            ctx.globalAlpha = 0.55
            ctx.setLineDash([4, 4])
            ctx.moveTo(chartArea.left, y)
            ctx.lineTo(chartArea.right, y)
            ctx.stroke()
            ctx.globalAlpha = 1
          }
        }
        if (hoverMs != null && scales.x) {
          const x = scales.x.getPixelForValue(hoverMs)
          if (x >= chartArea.left && x <= chartArea.right) {
            ctx.beginPath()
            ctx.strokeStyle = themeColor('--color-primary', '#2563eb')
            ctx.setLineDash([])
            ctx.lineWidth = 1
            ctx.moveTo(x, chartArea.top)
            ctx.lineTo(x, chartArea.bottom)
            ctx.stroke()
          }
        }
        ctx.restore()
      },
    }),
    [hoverMs, threshold],
  )

  return (
    <Line
      plugins={[guide]}
      data={{
        datasets: series.map((item) => {
          const nums = item.data.filter((value): value is number => value != null && !Number.isNaN(value))
          const spanLabel =
            nums.length > 0 ? `${item.label} ${tick(unit, Math.min(...nums))}–${tick(unit, Math.max(...nums))}` : item.label
          return {
            label: spanLabel,
            data: withGaps(aligned, item.data, limit),
            borderColor: item.color,
            backgroundColor: item.color,
            borderWidth: 1.75,
            borderJoinStyle: 'round',
            borderCapStyle: 'round',
            fill: false,
            pointRadius: aligned.length <= 2 ? 3 : 0,
            pointHoverRadius: 4,
            pointHitRadius: 8,
            pointBackgroundColor: item.color,
            tension: 0,
            cubicInterpolationMode: 'monotone',
            spanGaps: false,
          }
        }),
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        onHover: (
          event: { x: number | null },
          _elements: unknown,
          chart: { scales: { x?: { getValueForPixel: (pixel: number) => number } } },
        ) => {
          if (event.x == null) return
          const x = chart.scales.x?.getValueForPixel(event.x)
          onHover(typeof x === 'number' && Number.isFinite(x) ? x : null)
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 8, boxHeight: 8, color: muted, font: { size: 11 }, padding: 10 },
          },
          tooltip: {
            backgroundColor: fg,
            titleColor: surface,
            bodyColor: surface,
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              title: (items: Array<{ parsed: { x: number | null } }>) => {
                const raw = items[0]?.parsed?.x
                return typeof raw === 'number' ? fmtWhen(raw, span, locale, precise) : ''
              },
              label: (item: { parsed: { y: number | null }; dataset: { label?: string } }) => {
                const raw = item.parsed.y
                if (raw == null || Number.isNaN(raw)) return ` ${item.dataset.label}`
                return ` ${item.dataset.label}: ${tick(unit, raw)}`
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: aligned[0],
            max: aligned.length > 1 ? aligned[aligned.length - 1] : (aligned[0] ?? 0) + 60_000,
            ticks: {
              color: muted,
              maxTicksLimit: 6,
              font: { size: 10 },
              callback: (value: string | number) => fmtWhen(Number(value), span, locale),
            },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            position: 'left',
            min: y.min,
            max: y.max,
            ticks: {
              color: muted,
              font: { size: 10 },
              maxTicksLimit: 5,
              callback: (value: string | number) => tick(unit, Number(value)),
            },
            grid: { color: grid },
            border: { display: false },
          },
        },
      }}
    />
  )
}
