/** Shared dashboard widget prefs (localStorage). Used by Dashboard + Settings. */

export type DashboardWidgetId =
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
  | 'list.upcoming_notes'
  | 'list.calendar'

export type WidgetVisibility = Record<DashboardWidgetId, boolean>

export const DASHBOARD_WIDGETS_KEY = 'dashboard.widgets.v1'

export const DEFAULT_WIDGETS: WidgetVisibility = {
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
  'list.upcoming_notes': true,
  'list.calendar': true,
}

/** Stable order for settings UI checkboxes. */
export const DASHBOARD_WIDGET_IDS = Object.keys(DEFAULT_WIDGETS) as DashboardWidgetId[]

export function readWidgets(): WidgetVisibility {
  try {
    const raw = localStorage.getItem(DASHBOARD_WIDGETS_KEY)
    if (!raw) return { ...DEFAULT_WIDGETS }
    const parsed = JSON.parse(raw) as Partial<WidgetVisibility>
    const out: WidgetVisibility = { ...DEFAULT_WIDGETS }
    for (const k of DASHBOARD_WIDGET_IDS) {
      if (typeof parsed[k] === 'boolean') out[k] = Boolean(parsed[k])
    }
    return out
  } catch {
    return { ...DEFAULT_WIDGETS }
  }
}

export function writeWidgets(next: WidgetVisibility): void {
  try {
    localStorage.setItem(DASHBOARD_WIDGETS_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}
