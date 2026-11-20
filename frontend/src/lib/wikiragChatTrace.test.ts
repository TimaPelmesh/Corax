import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WikiRagAgentStep } from '../api'
import {
  loadWikiRagChats,
  newWikiRagSession,
  saveWikiRagChats,
  sendWikiRagChatMessage,
  WIKIRAG_CHATS_KEY,
} from './wikiragChatStore'

const streamMock = vi.fn()

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    streamWikiRagChat: (...args: unknown[]) => streamMock(...args),
  }
})

describe('wikirag chat SSE step → turn.trace', () => {
  beforeEach(() => {
    localStorage.removeItem(WIKIRAG_CHATS_KEY)
    streamMock.mockReset()
  })

  it('accumulates AgentStep into assistant turn.trace', async () => {
    const session = newWikiRagSession('Тест')
    saveWikiRagChats([session], session.id)

    streamMock.mockImplementation(async (_body, callbacks) => {
      const s1: WikiRagAgentStep = {
        id: 's1',
        kind: 'goal',
        title: 'Найти принтеры',
        status: 'done',
        iteration: 0,
      }
      const s2: WikiRagAgentStep = {
        id: 's2',
        kind: 'tool',
        title: 'Тул: search_printers',
        detail: 'search_printers(toner_lt=5)',
        status: 'running',
        iteration: 1,
      }
      callbacks.onStep?.(s1)
      callbacks.onStep?.(s2)
      callbacks.onStep?.({ ...s2, status: 'done' })
      callbacks.onDelta('Вывод: два принтера.')
      callbacks.onDone({
        ok: true,
        raw: 'Вывод: два принтера.',
        parsed: { answer: 'Вывод: два принтера.', sources: [] },
        meta: {
          trace: [
            s1,
            { ...s2, status: 'done' },
            { id: 's3', kind: 'answer', title: 'Ответ готов', status: 'done' },
          ],
        },
      })
    })

    expect(
      sendWikiRagChatMessage({
        sessionId: session.id,
        message: 'принтеры без тонера',
        fallbackTitle: 'Тест',
        emptyModelResponse: '(пусто)',
        errorFallback: 'ошибка',
      }),
    ).toBe(true)

    await vi.waitFor(() => {
      const loaded = loadWikiRagChats('Тест')
      const assistant = loaded.sessions[0]?.turns.find((t) => t.role === 'assistant')
      expect(assistant?.content).toContain('два принтера')
      expect(assistant?.trace?.length).toBeGreaterThanOrEqual(2)
      expect(assistant?.trace?.some((s) => s.kind === 'goal')).toBe(true)
      expect(assistant?.trace?.some((s) => s.kind === 'tool' || s.kind === 'answer')).toBe(true)
    })
  })
})
