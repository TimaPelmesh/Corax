import {
  Chart as ChartJS,
  CategoryScale,
  Filler,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
} from 'chart.js'
import { Line } from 'react-chartjs-2'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler)

export type AuditSeries = {
  label: string
  color: string
  data: Array<number | null>
  axis?: 'y' | 'y1'
}

type Props = {
  labels: string[]
  series: AuditSeries[]
  percent?: boolean
  unit?: 'temp' | 'percent' | 'rate' | 'load'
}

function tick(unit: Props['unit'], value: string | number) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return String(value)
  if (unit === 'percent') return `${Math.round(n)}%`
  if (unit === 'temp') return `${Math.round(n)}°`
  if (unit === 'rate') {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`
    if (n >= 1024) return `${Math.round(n / 1024)}K`
    return `${Math.round(n)}`
  }
  return n >= 10 ? n.toFixed(0) : n.toFixed(1)
}

export function ServerAuditCharts({ labels, series, percent, unit }: Props) {
  const scale = unit ?? (percent ? 'percent' : undefined)
  const hasRight = series.some((item) => item.axis === 'y1')
  return (
    <Line
      data={{
        labels,
        datasets: series.map((item) => ({
          label: item.label,
          data: item.data,
          borderColor: item.color,
          backgroundColor: `${item.color}33`,
          borderWidth: 2,
          fill: true,
          pointRadius: labels.length <= 2 ? 3.5 : 0,
          pointHoverRadius: 4,
          pointBackgroundColor: item.color,
          tension: 0.35,
          spanGaps: true,
          yAxisID: item.axis || 'y',
        })),
      }}
      options={{
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { boxWidth: 8, boxHeight: 8, color: '#64748b', font: { size: 11 }, padding: 12 },
          },
          tooltip: {
            backgroundColor: '#0f172a',
            titleColor: '#e2e8f0',
            bodyColor: '#f8fafc',
            padding: 10,
            cornerRadius: 8,
            callbacks: {
              label: (item: { parsed: { y: number | null }; dataset: { label?: string } }) => {
                const raw = item.parsed.y
                if (raw == null || Number.isNaN(raw)) return ` ${item.dataset.label}`
                return ` ${item.dataset.label}: ${tick(scale, raw)}`
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#64748b', maxTicksLimit: 6, font: { size: 10 } },
            grid: { display: false },
            border: { display: false },
          },
          y: {
            position: 'left',
            min: scale === 'percent' ? 0 : undefined,
            suggestedMax: scale === 'percent' ? 100 : scale === 'temp' ? 80 : undefined,
            ticks: {
              color: '#64748b',
              font: { size: 10 },
              maxTicksLimit: 5,
              callback: (value: string | number) => tick(scale, value),
            },
            grid: { color: 'rgba(148, 163, 184, 0.16)' },
            border: { display: false },
          },
          ...(hasRight
            ? {
                y1: {
                  position: 'right' as const,
                  grid: { drawOnChartArea: false },
                  ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 5 },
                  border: { display: false },
                },
              }
            : {}),
        },
      }}
    />
  )
}
