import { useMemo } from 'react'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js'
import { Bar } from 'react-chartjs-2'
import type { TicketHandlerStats } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { useTheme } from '../../ThemeContext'

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler)

type Props = {
  stats: TicketHandlerStats | null
}

export function HandlerStatsCharts({ stats }: Props) {
  const t = useT()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const series = stats?.series ?? []
  const hasData = series.some((p) => p.total > 0)

  const chart = useMemo(() => {
    const labels = series.map((p) => p.date.slice(5))
    return {
      labels,
      datasets: [
        {
          label: t('ticketHandler.kpiTotal'),
          data: series.map((p) => p.total),
          backgroundColor: isDark ? 'rgba(56, 189, 248, 0.45)' : 'rgba(14, 165, 233, 0.4)',
          borderRadius: 6,
          maxBarThickness: 22,
        },
        {
          label: t('ticketHandler.kpiCreated'),
          data: series.map((p) => p.created_ticket),
          backgroundColor: isDark ? 'rgba(52, 211, 153, 0.4)' : 'rgba(16, 185, 129, 0.35)',
          borderRadius: 6,
          maxBarThickness: 22,
        },
        {
          label: t('ticketHandler.kpiErrors'),
          data: series.map((p) => p.error),
          backgroundColor: isDark ? 'rgba(251, 113, 133, 0.4)' : 'rgba(244, 63, 94, 0.3)',
          borderRadius: 6,
          maxBarThickness: 22,
        },
      ],
    }
  }, [series, t, isDark])

  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index' as const, intersect: false },
      plugins: {
        legend: {
          position: 'bottom' as const,
          labels: {
            color: isDark ? '#94a3b8' : '#64748b',
            boxWidth: 10,
            boxHeight: 10,
            borderRadius: 3,
            useBorderRadius: true,
            font: { size: 11 },
            padding: 16,
          },
        },
        tooltip: {
          backgroundColor: isDark ? 'rgba(15,23,42,0.92)' : 'rgba(255,255,255,0.96)',
          titleColor: isDark ? '#e2e8f0' : '#0f172a',
          bodyColor: isDark ? '#cbd5e1' : '#334155',
          borderColor: isDark ? 'rgba(148,163,184,0.25)' : 'rgba(15,23,42,0.08)',
          borderWidth: 1,
          padding: 10,
          cornerRadius: 8,
        },
      },
      scales: {
        x: {
          ticks: { color: isDark ? '#64748b' : '#94a3b8', maxRotation: 0, font: { size: 10 } },
          grid: { display: false },
          border: { display: false },
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: isDark ? '#64748b' : '#94a3b8',
            precision: 0,
            font: { size: 10 },
          },
          grid: { color: isDark ? 'rgba(148,163,184,0.1)' : 'rgba(15,23,42,0.05)' },
          border: { display: false },
        },
      },
    }),
    [isDark],
  )

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-sm sm:p-5">
      <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">{t('ticketHandler.chartTitle')}</h2>
      <p className="mb-4 text-xs text-[var(--color-fg-muted)]">{t('ticketHandler.chartSubtitle')}</p>
      {!hasData ? (
        <div className="flex h-52 flex-col items-center justify-center gap-2 rounded-lg bg-[var(--color-bg-muted)]/50">
          <div className="h-16 w-40 rounded-md bg-[var(--color-border)]/40" aria-hidden />
          <p className="max-w-sm text-center text-sm text-[var(--color-fg-muted)]">{t('ticketHandler.chartEmpty')}</p>
        </div>
      ) : (
        <div className="h-56 sm:h-64">
          <Bar data={chart} options={options} />
        </div>
      )}
    </div>
  )
}
