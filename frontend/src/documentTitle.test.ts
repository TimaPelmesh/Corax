import { describe, expect, it } from 'vitest'
import { titleForPath } from './documentTitle'

describe('titleForPath', () => {
  it('resolves ticket list for /requests and /requests/database', () => {
    expect(titleForPath('/requests', 'ru')).toMatch(/заяв/i)
    expect(titleForPath('/requests/database', 'ru')).toMatch(/заяв/i)
    expect(titleForPath('/requests', 'en')).toMatch(/ticket/i)
  })

  it('resolves dashboard and notes', () => {
    expect(titleForPath('/', 'ru')).toContain('Дашборд')
    expect(titleForPath('/knowledge-base/notes', 'ru')).toMatch(/Заметк/)
    expect(titleForPath('/', 'en')).toMatch(/Dashboard/i)
  })

  it('resolves the network map route', () => {
    expect(titleForPath('/network-map', 'ru')).toMatch(/Карта сети/)
    expect(titleForPath('/network-map', 'en')).toMatch(/Network map/i)
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

  it('resolves zabbix data knowledge route', () => {
    expect(titleForPath('/knowledge-base/zabbix', 'ru')).toMatch(/Zabbix/)
    expect(titleForPath('/knowledge-base/zabbix', 'en')).toMatch(/Zabbix/i)
  })

  it('resolves the public helpdesk /h (and legacy /r redirect target title)', () => {
    expect(titleForPath('/h', 'ru')).toMatch(/заяв/i)
    expect(titleForPath('/r', 'ru')).toMatch(/заяв/i)
    expect(titleForPath('/h', 'en')).toMatch(/ticket|request|handler/i)
  })

  it('strips trailing slash and falls back', () => {
    expect(titleForPath('/computers/', 'en')).toMatch(/Computer/i)
    expect(titleForPath('/unknown-route-xyz', 'ru')).toBe('CORAX')
  })
})
