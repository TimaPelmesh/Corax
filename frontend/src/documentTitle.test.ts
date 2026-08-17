import { describe, expect, it } from 'vitest'
import { titleForPath } from './documentTitle'

describe('titleForPath', () => {
  it('resolves dashboard and notes', () => {
    expect(titleForPath('/', 'ru')).toContain('Дашборд')
    expect(titleForPath('/knowledge-base/notes', 'ru')).toMatch(/Заметк/)
    expect(titleForPath('/', 'en')).toMatch(/Dashboard/i)
  })

  it('resolves https settings route', () => {
    expect(titleForPath('/settings/https', 'ru')).toMatch(/HTTPS/i)
    expect(titleForPath('/settings/https', 'en')).toMatch(/HTTPS/i)
  })

  it('resolves warehouse, settings hub, and guide', () => {
    expect(titleForPath('/warehouse', 'ru')).toMatch(/Склад/)
    expect(titleForPath('/knowledge-base/warehouse', 'ru')).toMatch(/Склад/)
    expect(titleForPath('/settings', 'ru')).toMatch(/Настройк/)
    expect(titleForPath('/knowledge-base/guide', 'en')).toMatch(/Guide/i)
  })

  it('strips trailing slash and falls back', () => {
    expect(titleForPath('/computers/', 'en')).toMatch(/Computer/i)
    expect(titleForPath('/unknown-route-xyz', 'ru')).toBe('CORAX')
  })
})
