import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../AuthContext'
import { IconDashboard } from '../components/icons'

type DashboardChartsMode = 'donut' | 'bars'

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

const MODE_KEY = 'dashboard.charts.mode'
const WIDGETS_KEY = 'dashboard.widgets.v1'

function readMode(): DashboardChartsMode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'bars' || v === 'donut' ? v : 'donut'
  } catch {
    return 'donut'
  }
}

function writeMode(m: DashboardChartsMode) {
  try {
    localStorage.setItem(MODE_KEY, m)
  } catch {
    // ignore
  }
}

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

function readWidgets(): WidgetVisibility {
  try {
    const raw = localStorage.getItem(WIDGETS_KEY)
    if (!raw) return { ...DEFAULT_WIDGETS }
    const parsed = JSON.parse(raw) as Partial<WidgetVisibility>
    const out: WidgetVisibility = { ...DEFAULT_WIDGETS }
    for (const k of Object.keys(DEFAULT_WIDGETS) as DashboardWidgetId[]) {
      if (typeof parsed[k] === 'boolean') out[k] = Boolean(parsed[k])
    }
    return out
  } catch {
    return { ...DEFAULT_WIDGETS }
  }
}

function writeWidgets(next: WidgetVisibility) {
  try {
    localStorage.setItem(WIDGETS_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
}

export function SettingsDashboardPage() {
  const { user } = useAuth()
  const canManage = Boolean(user?.is_superuser)

  if (!canManage) {
    return <Navigate to="/" replace />
  }

  const [mode, setMode] = useState<DashboardChartsMode>(() => readMode())
  const [widgets, setWidgets] = useState<WidgetVisibility>(() => readWidgets())

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MODE_KEY) setMode(readMode())
      if (e.key === WIDGETS_KEY) setWidgets(readWidgets())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const widgetRows = useMemo(
    () =>
      [
        { id: 'stat.computers_total', label: 'Плашка: Рабочих станций' },
        { id: 'stat.software_unique_titles', label: 'Плашка: Названий ПО' },
        { id: 'stat.tags_in_directory', label: 'Плашка: Тегов' },
        { id: 'stat.snmp_printers_total', label: 'Плашка: Принтеры (SNMP)' },
        { id: 'stat.physical_disks_total', label: 'Плашка: Физические диски (всего + SSD/HDD)' },
        { id: 'dist.by_os', label: 'Диаграмма: Операционные системы' },
        { id: 'dist.by_manufacturer', label: 'Диаграмма: Производители (OEM)' },
        { id: 'dist.ram_buckets', label: 'Диаграмма: Оперативная память' },
        { id: 'dist.top_monitors', label: 'Диаграмма: Мониторы' },
        { id: 'dist.by_system_model', label: 'Диаграмма: Модели (WMI)' },
        { id: 'dist.top_cpu', label: 'Диаграмма: Процессоры' },
        { id: 'dist.physical_disks', label: 'Диаграмма: Физические диски (SSD 240 ГБ, HDD …)' },
        { id: 'list.top_disk_devices', label: 'Список: Локальные диски' },
        { id: 'list.top_software', label: 'Список: Топ установленного ПО' },
        { id: 'list.peripheral_kinds', label: 'Список: Периферия по категориям' },
        { id: 'list.top_peripherals', label: 'Список: Частые устройства (PnP)' },
      ] as const,
    [],
  )

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconDashboard className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">Настройка дашборда</h1>
          <p className="mt-1 max-w-3xl text-slate-600">Включение плашек и выбор вида диаграмм.</p>
        </div>
      </div>

      <div className="app-card max-w-2xl space-y-4 p-6 sm:p-7">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Вид диаграмм</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
              mode === 'donut'
                ? 'border-neutral-900 bg-neutral-950 text-white shadow-neutral-900/10'
                : 'border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50'
            }`}
            onClick={() => {
              setMode('donut')
              writeMode('donut')
            }}
          >
            Круговые
            <div className={`mt-1 text-xs font-medium ${mode === 'donut' ? 'text-white/80' : 'text-slate-500'}`}>
              Компактно, хорошо для долей
            </div>
          </button>
          <button
            type="button"
            className={`rounded-xl border px-4 py-3 text-left text-sm font-semibold transition ${
              mode === 'bars'
                ? 'border-neutral-900 bg-neutral-950 text-white shadow-neutral-900/10'
                : 'border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-50'
            }`}
            onClick={() => {
              setMode('bars')
              writeMode('bars')
            }}
          >
            Столбчатые (горизонтальные)
            <div className={`mt-1 text-xs font-medium ${mode === 'bars' ? 'text-white/80' : 'text-slate-500'}`}>
              Лучше читаются по абсолютным значениям
            </div>
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm text-slate-700">
          Применяется к блоку «Распределение и нагрузка» на главном экране.
        </div>
      </div>

      <div className="app-card mt-4 max-w-2xl space-y-4 p-6 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Плашки дашборда</h2>
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100"
            onClick={() => {
              const next = { ...DEFAULT_WIDGETS }
              setWidgets(next)
              writeWidgets(next)
            }}
          >
            Сбросить
          </button>
        </div>

        <div className="space-y-2">
          {widgetRows.map((w) => {
            const id = w.id as DashboardWidgetId
            const on = Boolean(widgets[id])
            return (
              <label
                key={id}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-slate-200/90 bg-white px-4 py-3 text-sm transition hover:bg-slate-50"
              >
                <span className="min-w-0 flex-1 text-slate-800">{w.label}</span>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => {
                    const next = { ...widgets, [id]: Boolean(e.target.checked) } as WidgetVisibility
                    setWidgets(next)
                    writeWidgets(next)
                  }}
                />
              </label>
            )
          })}
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-sm text-slate-700">
          Изменения применяются сразу. Выключенные элементы скрываются на главном экране.
        </div>
      </div>
    </div>
  )
}

