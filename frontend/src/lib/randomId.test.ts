import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './randomId'

describe('randomId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses randomUUID when the browser provides it', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => '11111111-2222-4333-8444-555555555555',
      getRandomValues: (buf: Uint8Array) => buf,
    })
    expect(randomId()).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('does not throw when randomUUID is missing', () => {
    const bytes = new Uint8Array(16).fill(7)
    vi.stubGlobal('crypto', {
      getRandomValues: (buf: Uint8Array) => {
        buf.set(bytes)
        return buf
      },
    })
    expect(randomId()).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('falls back when crypto is absent', () => {
    vi.stubGlobal('crypto', undefined)
    expect(randomId().length).toBeGreaterThan(8)
  })
})
