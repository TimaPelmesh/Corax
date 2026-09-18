import { describe, expect, it } from 'vitest'
import { buildNavSections, prefsNavItems } from './navConfig'

describe('buildNavSections', () => {
  it('hides the inventory heading and puts Settings last as a flyout', () => {
    const sections = buildNavSections({ is_superuser: true, role: 'admin' })
    const inventory = sections.find((s) => s.titleKey === 'nav.inventory')
    const settings = sections[sections.length - 1]
    expect(inventory?.hideTitle).toBe(true)
    expect(settings?.titleKey).toBe('nav.settings')
    expect(settings?.flyout).toBe(true)
    expect(settings?.items[0]?.to).toBe('/settings/llm')
    expect(settings?.items.at(-1)?.to).toBe('/settings/https')
  })

  it('puts the floor map and Zabbix with inventory, next to risks and the network map', () => {
    const sections = buildNavSections({ is_superuser: true })
    const inventory = (sections.find((s) => s.titleKey === 'nav.inventory')?.items ?? []).map((i) => i.to)
    expect(inventory).toEqual([
      '/',
      '/risks',
      '/knowledge-base/zabbix',
      '/computers',
      '/software',
      '/printers',
      '/network',
      '/network-map',
      '/knowledge-base/sitemap',
      '/warehouse',
    ])
  })

  it('keeps knowledge as WikiRAG, the guide, and notes', () => {
    const sections = buildNavSections({ is_superuser: true })
    const kb = sections.find((s) => s.titleKey === 'nav.knowledge')
    const paths = (kb?.items ?? []).map((i) => i.to)
    expect(paths).toEqual(['/knowledge-base/wikirag', '/knowledge-base/guide', '/knowledge-base/notes'])
  })

  it('puts tickets as list, templates, and stats — create is a button, not a tab', () => {
    const sections = buildNavSections({ is_superuser: true })
    const tickets = sections.find((s) => s.titleKey === 'nav.requests')
    expect((tickets?.items ?? []).map((i) => i.to)).toEqual([
      '/requests/database',
      '/requests/templates',
      '/requests/stats',
    ])
  })
})

describe('prefsNavItems', () => {
  it('still lists every moved tab so hidden-nav prefs keep working', () => {
    const paths = prefsNavItems({ role: 'observer' }).map((i) => i.path)
    expect(paths).toContain('/knowledge-base/guide')
    expect(paths).toContain('/knowledge-base/zabbix')
    expect(paths).toContain('/knowledge-base/sitemap')
    expect(paths).toContain('/knowledge-base/notes')
    expect(paths).toContain('/knowledge-base/wikirag')
    expect(paths).not.toContain('/users')
  })
})
