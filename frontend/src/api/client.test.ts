import { afterEach, describe, expect, it, vi } from 'vitest'

describe('api client retries', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('retries GET on 503 then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'ok', api: 'v1' }),
      })
    vi.stubGlobal('fetch', fetchMock)
    const { request, API_PREFIX } = await import('./client')
    await expect(request(`${API_PREFIX}/health`)).resolves.toEqual({ status: 'ok', api: 'v1' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry POST', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    })
    vi.stubGlobal('fetch', fetchMock)
    const { request, API_PREFIX } = await import('./client')
    await expect(request(`${API_PREFIX}/auth/logout`, { method: 'POST' })).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
