import { describe, expect, it, beforeEach } from 'vitest'
import {
  isWikiRagChatPending,
  loadWikiRagChats,
  newWikiRagSession,
  saveWikiRagChats,
  WIKIRAG_CHATS_KEY,
} from './wikiragChatStore'

describe('wikiragChatStore', () => {
  beforeEach(() => {
    localStorage.removeItem(WIKIRAG_CHATS_KEY)
  })

  it('round-trips sessions', () => {
    const s = newWikiRagSession('Новый чат')
    s.turns = [{ role: 'user', content: 'hi' }]
    expect(saveWikiRagChats([s], s.id)).toBe(true)
    expect(saveWikiRagChats([s], s.id)).toBe(false)
    const loaded = loadWikiRagChats('Новый чат')
    expect(loaded.activeId).toBe(s.id)
    expect(loaded.sessions[0]?.turns[0]?.content).toBe('hi')
  })

  it('tracks pending map empty by default', () => {
    expect(isWikiRagChatPending('missing')).toBe(false)
  })
})
