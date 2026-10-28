import { describe, expect, it } from 'vitest'
import {
  catalogFilterKey,
  hostKeys,
  normalizeZabbixHref,
  severityClass,
  severityRank,
} from './knowledgeZabbixModel'

describe('hostKeys', () => {
  it('returns empty for blank', () => {
    expect(hostKeys('')).toEqual([])
    expect(hostKeys('   ')).toEqual([])
  })

  it('adds short hostname for FQDN', () => {
    expect(hostKeys('PC-01.corp.local')).toEqual(['pc-01.corp.local', 'pc-01'])
  })

  it('keeps single key when no domain', () => {
    expect(hostKeys('PC-01')).toEqual(['pc-01'])
  })
})

describe('severityRank / severityClass', () => {
  it('ranks finite numbers', () => {
    expect(severityRank(4)).toBe(4)
    expect(severityRank(Number.NaN)).toBe(0)
  })

  it('maps ranks to token classes', () => {
    expect(severityClass(5)).toContain('--color-error')
    expect(severityClass(4)).toContain('--color-warning')
    expect(severityClass(2)).toContain('--color-info')
    expect(severityClass(0)).toContain('--color-fg-muted')
  })
})

describe('normalizeZabbixHref', () => {
  it('accepts absolute urls', () => {
    expect(normalizeZabbixHref('https://zabbix.example/')).toBe('https://zabbix.example/')
  })

  it('prefixes host-like values with http', () => {
    expect(normalizeZabbixHref('zabbix.local:8080')).toBe('http://zabbix.local:8080')
  })

  it('rejects garbage', () => {
    expect(normalizeZabbixHref('not a url')).toBe('')
  })
})

describe('catalogFilterKey', () => {
  it('joins kind and name', () => {
    expect(catalogFilterKey('software', 'Chrome')).toBe('software::Chrome')
  })
})
