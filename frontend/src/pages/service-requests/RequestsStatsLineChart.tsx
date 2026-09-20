import type { ComponentProps } from 'react'
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

type LineProps = ComponentProps<typeof Line>

/** Chart.js chunk — loaded only when the requests stats tab mounts. */
export default function RequestsStatsLineChart({ data, options }: LineProps) {
  return <Line data={data} options={options} />
}
