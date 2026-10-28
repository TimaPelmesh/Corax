import { describe, expect, it } from 'vitest'
import { buildNavSections, prefsNavItems } from './navConfig'

function settingsPaths(user: { is_superuser?: boolean; role?: string } | null) {
  return (buildNavSections(user).find((s) => s.titleKey === 'nav.settings')?.items ?? []).map((i) => i.to)
}

describe('buildNavSections', () => {
  it('hides the Inventory heading and keeps Settings last as a flyout', () => {
    const sections = buildNavSections({ is_superuser: true, role: 'admin' })
    const keys = sections.map((s) => s.titleKey)
    expect(keys).toEqual(['nav.inventory', 'nav.requests', 'nav.knowledge', 'nav.settings'])
    const inventory = sections.find((s) => s.titleKey === 'nav.inventory')
    const settings = sections[sections.length - 1]
    expect(inventory?.hideTitle).toBe(true)
    expect(settings?.titleKey).toBe('nav.settings')
    expect(settings?.flyout).toBe(true)
    expect(settings?.items[0]?.to).toBe('/settings/llm')
    expect(settings?.items.at(-1)?.to).toBe('/settings/https')
  })

  it('keeps dashboard, risks and assets in one unlabeled list so there is no gap', () => {
    const sections = buildNavSections({ is_superuser: true })
    const inventory = (sections.find((s) => s.titleKey === 'nav.inventory')?.items ?? []).map((i) => i.to)
    expect(inventory).toEqual([
      '/',
      '/risks',
      '/computers',
      '/server-audit',
      '/software',
      '/printers',
      '/network',
      '/network-map',
      '/warehouse',
    ])
  })

  it('puts Wiki, notes, the floor map and Zabbix under knowledge as an open labeled list', () => {
    const sections = buildNavSections({ is_superuser: true })
    const kb = sections.find((s) => s.titleKey === 'nav.knowledge')
    const tickets = sections.find((s) => s.titleKey === 'nav.requests')
    const paths = (kb?.items ?? []).map((i) => i.to)
    expect(kb?.collapsible).toBe(false)
    expect(tickets?.collapsible).toBe(false)
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

  it('limits llm-operator to a single server-audit entry', () => {
    const sections = buildNavSections({ role: 'llm-operator', is_superuser: false })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.titleKey).toBe('nav.serverAudit')
    expect(sections[0]?.hideTitle).toBe(true)
    expect((sections[0]?.items ?? []).map((i) => i.to)).toEqual(['/server-audit'])
  })

  it('does not treat a superuser with llm-operator role as the narrow shell', () => {
    const keys = buildNavSections({ role: 'llm-operator', is_superuser: true }).map((s) => s.titleKey)
    expect(keys).toEqual(['nav.inventory', 'nav.requests', 'nav.knowledge', 'nav.settings'])
  })

  it('gives editors tags and categories but not admin-only settings', () => {
    const paths = settingsPaths({ role: 'editor', is_superuser: false })
    expect(paths).toEqual(['/settings/llm', '/settings/tags', '/settings/categories'])
  })

  it('gives observers only the LLM settings entry', () => {
    expect(settingsPaths({ role: 'observer' })).toEqual(['/settings/llm'])
  })

  it('gives superusers the full settings list ending in HTTPS', () => {
    const paths = settingsPaths({ is_superuser: true })
    expect(paths[0]).toBe('/settings/llm')
    expect(paths).toContain('/users')
    expect(paths).toContain('/settings/agent-tokens')
    expect(paths).toContain('/settings/wol')
    expect(paths.at(-1)).toBe('/settings/https')
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

  it('limits llm-operator prefs to server-audit', () => {
    expect(prefsNavItems({ role: 'llm-operator' }).map((i) => i.path)).toEqual(['/server-audit'])
  })

  it('adds tags and categories for editors', () => {
    const paths = prefsNavItems({ role: 'editor' }).map((i) => i.path)
    expect(paths).toContain('/settings/tags')
    expect(paths).toContain('/settings/categories')
    expect(paths).not.toContain('/users')
    expect(paths).not.toContain('/settings/https')
  })

  it('adds admin prefs for superusers', () => {
    const paths = prefsNavItems({ is_superuser: true }).map((i) => i.path)
    expect(paths).toContain('/users')
    expect(paths).toContain('/settings/ldap')
    expect(paths).toContain('/settings/agent-bundle')
    expect(paths).toContain('/settings/https')
  })
})
