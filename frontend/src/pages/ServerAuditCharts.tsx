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

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend)

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
}

export function ServerAuditCharts({ labels, series, percent }: Props) {
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
          pointRadius: labels.length <= 1 ? 4 : labels.length > 80 ? 0 : 2,
          pointHoverRadius: 4,
          tension: 0.25,
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
            labels: { boxWidth: 10, color: '#64748b', font: { size: 11 } },
          },
        },
        scales: {
          x: {
            ticks: { color: '#64748b', maxTicksLimit: 8, font: { size: 10 } },
            grid: { display: false },
          },
          y: {
            position: 'left',
            min: percent ? 0 : undefined,
            suggestedMax: percent ? 100 : undefined,
            ticks: { color: '#64748b', font: { size: 10 } },
            grid: { color: 'rgba(148, 163, 184, 0.18)' },
          },
          ...(hasRight
            ? {
                y1: {
                  position: 'right' as const,
                  grid: { drawOnChartArea: false },
                  ticks: { color: '#64748b', font: { size: 10 } },
                },
              }
            : {}),
        },
      }}
    />
  )
}
