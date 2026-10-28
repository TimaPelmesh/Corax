import { describe, expect, it } from 'vitest'
import { formatZabbixClock } from './zabbixUi'

describe('formatZabbixClock', () => {
  it('returns an em dash for missing or non-positive clocks', () => {
    expect(formatZabbixClock(null, 'ru')).toBe('—')
    expect(formatZabbixClock(undefined, 'en')).toBe('—')
    expect(formatZabbixClock(0, 'ru')).toBe('—')
    expect(formatZabbixClock(Number.NaN, 'en')).toBe('—')
  })

  it('formats unix seconds with the locale date string', () => {
    const stamp = Date.UTC(2024, 0, 15, 12, 30) / 1000
    const ru = formatZabbixClock(stamp, 'ru')
    const en = formatZabbixClock(stamp, 'en')
    expect(ru).not.toBe('—')
    expect(en).not.toBe('—')
    expect(ru).toMatch(/15/)
    expect(en).toMatch(/15/)
  })
})
