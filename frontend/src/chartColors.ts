import type { ThemeMode } from './theme'

/** Согласованная палитра для кольцевых диаграмм (нейтральная база + синий акцент) */
export const DONUT_COLORS_LIGHT = [
  '#2563eb',
  '#18181b',
  '#3f3f46',
  '#71717a',
  '#1d4ed8',
  '#52525b',
  '#a1a1aa',
  '#e4e4e7',
  '#1e40af',
  '#27272a',
  '#d4d4d8',
  '#78716c',
] as const

export const DONUT_COLORS_DARK = [
  '#3b82f6',
  '#e2e8f0',
  '#94a3b8',
  '#60a5fa',
  '#2563eb',
  '#cbd5e1',
  '#1d4ed8',
  '#64748b',
  '#93c5fd',
  '#f1f5f9',
  '#1e40af',
  '#475569',
] as const

export function donutColorsForTheme(theme: ThemeMode): readonly string[] {
  return theme === 'dark' ? DONUT_COLORS_DARK : DONUT_COLORS_LIGHT
}
