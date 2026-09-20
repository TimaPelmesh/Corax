import { describe, expect, it } from 'vitest'
import { filterGuideSections, guideCopy } from './guideContent'

/** Paths that exist in App.tsx (plus public /r /h). Guide links must stay inside this set. */
const APP_PATHS = new Set([
  '/',
  '/login',
  '/r',
  '/h',
  '/risks',
  '/software',
  '/computers',
  '/printers',
  '/network',
  '/network-map',
  '/requests',
  '/requests/database',
  '/requests/stats',
  '/requests/templates',
  '/users',
  '/settings',
  '/settings/tags',
  '/settings/categories',
  '/settings/ldap',
  '/settings/bitrix24',
  '/settings/zabbix',
  '/settings/database',
  '/settings/glpi',
  '/settings/llm',
  '/settings/agent-tokens',
  '/settings/agent-bundle',
  '/settings/wol',
  '/settings/https',
  '/knowledge-base',
  '/knowledge-base/sitemap',
  '/knowledge-base/guide',
  '/knowledge-base/wikirag',
  '/knowledge-base/notes',
  '/knowledge-base/zabbix',
  '/warehouse',
])

const REQUIRED_SECTION_IDS = [
  'start',
  'dashboard',
  'risks',
  'computers',
  'agent',
  'agent-linux',
  'agent-audit',
  'software',
  'printers',
  'network',
  'requests',
  'shortcuts',
  'knowledge',
  'warehouse',
  'sitemap',
  'wikirag',
  'notes',
  'zabbix',
  'search',
  'admin',
  'ops',
  'security',
] as const

const FORBIDDEN_SHORTCUT_NAMES = ['Заявка CORAX', 'CORAX-ticket', 'CORAX ticket', 'Заявка в IT']

function allGuideText(locale: 'ru' | 'en'): string {
  const copy = guideCopy(locale)
  const chunks = [copy.title, copy.subtitle, copy.tipBody]
  for (const section of copy.sections) {
    chunks.push(section.title, section.summary)
    for (const step of section.steps) chunks.push(step.title, step.body)
    for (const link of section.links ?? []) chunks.push(link.to, link.label)
  }
  return chunks.join('\n')
}

describe('guideCopy', () => {
  it('keeps the same section ids in ru and en', () => {
    const ru = guideCopy('ru').sections.map((s) => s.id)
    const en = guideCopy('en').sections.map((s) => s.id)
    expect(ru).toEqual(en)
    expect(ru).toEqual([...REQUIRED_SECTION_IDS])
  })

  it('links only to real app routes', () => {
    for (const locale of ['ru', 'en'] as const) {
      for (const section of guideCopy(locale).sections) {
        for (const link of section.links ?? []) {
          expect(APP_PATHS.has(link.to), `${locale} ${section.id} → ${link.to}`).toBe(true)
        }
      }
    }
  })

  it('documents knowledge as WikiRAG plus guide and notes; floor and Zabbix stay linked elsewhere', () => {
    const knowledge = guideCopy('ru').sections.find((s) => s.id === 'knowledge')
    expect((knowledge?.links ?? []).map((l) => l.to)).toEqual([
      '/knowledge-base/wikirag',
      '/knowledge-base/guide',
      '/knowledge-base/notes',
    ])
    const allLinks = guideCopy('ru').sections.flatMap((s) => (s.links ?? []).map((l) => l.to))
    expect(allLinks).toEqual(
      expect.arrayContaining([
        '/knowledge-base/sitemap',
        '/knowledge-base/guide',
        '/knowledge-base/wikirag',
        '/knowledge-base/notes',
        '/knowledge-base/zabbix',
      ]),
    )
  })

  it('names the desktop shortcut Оставить заявку and uses LAN IP, not localhost', () => {
    for (const locale of ['ru', 'en'] as const) {
      const text = allGuideText(locale)
      expect(text).toContain('Оставить заявку')
      expect(text).toMatch(/\/h#pc=/)
      expect(text).toContain('LAN-IP')
      for (const banned of FORBIDDEN_SHORTCUT_NAMES) {
        expect(text.includes(banned), `${locale} still mentions "${banned}"`).toBe(false)
      }
    }
  })

  it('documents /h as the only public helpdesk and /r as a redirect', () => {
    for (const locale of ['ru', 'en'] as const) {
      const text = allGuideText(locale)
      expect(text).not.toMatch(/\/r —/)
      expect(text).toMatch(/\/h/)
      expect(text).toMatch(/перенаправ|redirect/i)
      expect(text).toMatch(/corax_send_silent\.vbs/)
    }
  })

  it('documents the full-audit agent path', () => {
    const ru = allGuideText('ru')
    const en = allGuideText('en')
    expect(ru).toContain('agent/audit-win/corax_audit.bat')
    expect(en).toContain('agent/audit-win/corax_audit.bat')
  })
})

describe('filterGuideSections', () => {
  it('returns all sections for an empty query', () => {
    const sections = guideCopy('ru').sections
    expect(filterGuideSections(sections, '  ')).toHaveLength(sections.length)
  })

  it('keeps a section when the title matches', () => {
    const hit = filterGuideSections(guideCopy('ru').sections, 'zabbix')
    expect(hit.map((s) => s.id)).toContain('zabbix')
  })

  it('narrows steps when only a step body matches', () => {
    const hit = filterGuideSections(guideCopy('ru').sections, 'corax_audit.bat')
    expect(hit).toHaveLength(1)
    expect(hit[0]?.id).toBe('agent-audit')
    expect(hit[0]?.steps.length).toBeGreaterThan(0)
    expect(hit[0]?.steps.every((s) => /corax_audit/i.test(s.title + s.body))).toBe(true)
  })

  it('returns empty when nothing matches', () => {
    expect(filterGuideSections(guideCopy('ru').sections, 'zzz-no-such-guide-term')).toEqual([])
  })
})
