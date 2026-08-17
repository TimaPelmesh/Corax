import { describe, expect, it } from 'vitest'
import { formatAvgCloseHours, formatDashboardLabel } from './DashboardWidgets'

const t = ((key: string, params?: Record<string, string | number>) => {
  if (key === 'dashboard.stats.requestsAvgClose.empty') return 'нет закрытых'
  if (key === 'dashboard.stats.requestsAvgClose.minutes') return `${params?.m} мин`
  if (key === 'dashboard.stats.requestsAvgClose.hours') return `${params?.h} ч`
  if (key === 'dashboard.stats.requestsAvgClose.days') return `${params?.d} д`
  return key
}) as Parameters<typeof formatAvgCloseHours>[1]

describe('formatDashboardLabel', () => {
  it('shortens Microsoft OS names', () => {
    expect(formatDashboardLabel('Microsoft Windows 10 Pro')).toBe('Windows 10 Pro')
    expect(formatDashboardLabel('Windows 10 Профессиональная')).toBe('Windows 10 Pro')
  })

  it('shortens Intel CPU strings', () => {
    expect(formatDashboardLabel('Intel(R) Core(TM) i5-10400 CPU @ 2.90GHz')).toBe('Core i5-10400')
  })

  it('truncates very long labels', () => {
    const long = 'A'.repeat(40)
    expect(formatDashboardLabel(long)).toBe(`${'A'.repeat(24)}…`)
  })
})

describe('formatAvgCloseHours', () => {
  it('handles empty / invalid', () => {
    expect(formatAvgCloseHours(null, t)).toBe('нет закрытых')
    expect(formatAvgCloseHours(Number.NaN, t)).toBe('нет закрытых')
    expect(formatAvgCloseHours(-1, t)).toBe('нет закрытых')
  })

  it('formats minutes, hours and days', () => {
    expect(formatAvgCloseHours(0.5, t)).toBe('30 мин')
    expect(formatAvgCloseHours(3.2, t)).toBe('3.2 ч')
    expect(formatAvgCloseHours(72, t)).toBe('3 д')
  })
})
