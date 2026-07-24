import type { ThemeMode } from './theme'

/** Светлая тема: как раньше — синий акцент + чёрные/серые сегменты */
export const DONUT_COLORS_LIGHT = [
  '#2563eb',
  '#18181b',
  '#3f3f46',
  '#71717a',
  '#1d4ed8',
  '#52525b',
  '#3b82f6',
  '#a1a1aa',
  '#1e40af',
  '#27272a',
  '#60a5fa',
  '#64748b',
] as const

/** Тёмная тема: синий / голубой */
export const DONUT_COLORS_DARK = [
  '#60a5fa',
  '#38bdf8',
  '#93c5fd',
  '#3b82f6',
  '#7dd3fc',
  '#2563eb',
  '#0ea5e9',
  '#bae6fd',
  '#1d4ed8',
  '#67e8f9',
  '#818cf8',
  '#a5b4fc',
] as const

export function donutColorsForTheme(theme: ThemeMode): readonly string[] {
  return theme === 'dark' ? DONUT_COLORS_DARK : DONUT_COLORS_LIGHT
}
