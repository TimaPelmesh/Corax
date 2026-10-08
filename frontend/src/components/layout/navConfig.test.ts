import { describe, expect, it } from 'vitest'
import { buildNavSections, prefsNavItems } from './navConfig'

describe('buildNavSections', () => {
  it('shows Inventory above tickets and keeps Settings last as a flyout', () => {
    const sections = buildNavSections({ is_superuser: true, role: 'admin' })
    const keys = sections.map((s) => s.titleKey)
    expect(keys).toEqual(['nav.overview', 'nav.inventory', 'nav.requests', 'nav.knowledge', 'nav.settings'])
    const inventory = sections.find((s) => s.titleKey === 'nav.inventory')
    const settings = sections[sections.length - 1]
    expect(inventory?.hideTitle).toBeFalsy()
    expect(settings?.titleKey).toBe('nav.settings')
    expect(settings?.flyout).toBe(true)
    expect(settings?.items[0]?.to).toBe('/settings/llm')
    expect(settings?.items.at(-1)?.to).toBe('/settings/https')
  })

  it('keeps dashboard and risks unlabeled above the asset list', () => {
    const sections = buildNavSections({ is_superuser: true })
    const overview = sections.find((s) => s.titleKey === 'nav.overview')
    const inventory = (sections.find((s) => s.titleKey === 'nav.inventory')?.items ?? []).map((i) => i.to)
    expect(overview?.hideTitle).toBe(true)
    expect((overview?.items ?? []).map((i) => i.to)).toEqual(['/', '/risks'])
    expect(inventory).toEqual([
      '/computers',
      '/software',
      '/printers',
      '/network',
      '/network-map',
      '/warehouse',
    ])
  })

  it('puts Wiki, notes, the floor map and Zabbix under knowledge, collapsed by default', () => {
    const sections = buildNavSections({ is_superuser: true })
    const kb = sections.find((s) => s.titleKey === 'nav.knowledge')
    const paths = (kb?.items ?? []).map((i) => i.to)
    expect(kb?.defaultCollapsed).toBe(true)
    expect(paths).toEqual([
      '/knowledge-base/wikirag',
      '/knowledge-base/guide',
      '/knowledge-base/notes',
      '/knowledge-base/sitemap',
      '/knowledge-base/zabbix',
    ])
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
