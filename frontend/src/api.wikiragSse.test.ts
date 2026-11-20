import { afterEach, describe, expect, it, vi } from 'vitest'
import { streamWikiRagChat, type WikiRagAgentStep } from './api'

function ssePacket(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

describe('streamWikiRagChat SSE step', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('invokes onStep for event: step', async () => {
    const packets =
      ssePacket('meta', { mode: 'agent' }) +
      ssePacket('step', {
        id: 's1',
        kind: 'plan',
        title: 'Ищу принтеры',
        status: 'running',
        iteration: 1,
      } satisfies WikiRagAgentStep) +
      ssePacket('delta', { text: 'Ответ' }) +
      ssePacket('done', { ok: true, raw: 'Ответ', meta: { trace: [{ id: 's1', kind: 'plan', title: 'Ищу принтеры' }] } })

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(packets))
        controller.close()
      },
    })

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
        statusText: 'OK',
        text: async () => '',
      }),
    )

    const steps: WikiRagAgentStep[] = []
    let doneMeta: { trace?: WikiRagAgentStep[] } | null | undefined
    await streamWikiRagChat(
      { message: 'hi' },
      {
        onStep: (s) => steps.push(s),
        onDelta: () => undefined,
        onDone: (res) => {
          doneMeta = res.meta
        },
      },
    )

    expect(steps).toHaveLength(1)
    expect(steps[0]?.kind).toBe('plan')
    expect(steps[0]?.title).toBe('Ищу принтеры')
    expect(doneMeta?.trace?.[0]?.id).toBe('s1')
  })
})
