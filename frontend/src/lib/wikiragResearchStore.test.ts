import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadWikiRagResearchChats,
  newWikiRagResearchSession,
  saveWikiRagResearchChats,
  WIKIRAG_RESEARCH_CHATS_KEY,
} from './wikiragResearchStore'

describe('wikiragResearchStore', () => {
  beforeEach(() => {
    localStorage.removeItem(WIKIRAG_RESEARCH_CHATS_KEY)
    localStorage.removeItem('inventory-wikirag-research-v1')
  })

  it('round-trips research sessions', () => {
    const s = newWikiRagResearchSession('Исследование')
    s.turns = [{ role: 'user', content: 'баобабы' }]
    expect(saveWikiRagResearchChats([s], s.id)).toBe(true)
    const loaded = loadWikiRagResearchChats('Исследование')
    expect(loaded.activeId).toBe(s.id)
    expect(loaded.sessions[0]?.turns[0]?.content).toBe('баобабы')
  })

  it('migrates the previous single-thread storage', () => {
    localStorage.setItem(
      'inventory-wikirag-research-v1',
      JSON.stringify({ turns: [{ role: 'user', content: 'старый чат' }] }),
    )
    const loaded = loadWikiRagResearchChats('Исследование')
    expect(loaded.sessions[0]?.turns[0]?.content).toBe('старый чат')
    expect(loaded.sessions[0]?.title).toContain('старый')
  })
})
