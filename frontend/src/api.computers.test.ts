import { afterEach, describe, expect, it, vi } from 'vitest'

describe('computers API helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('computer() omits software via query when includeSoftware=false', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 1,
        hostname: 'pc-1',
        software: [],
        peripherals: [],
        tags: [],
        disks: [],
        software_count: 3,
        peripheral_count: 0,
        serial_number: null,
        mac_primary: null,
        cpu: null,
        ram_gb: null,
        memory_used_percent: null,
        gpu_name: null,
        os_name: null,
        os_version: null,
        manufacturer: null,
        model: null,
        last_report_at: null,
        location: null,
        notes: null,
        assigned_user_id: null,
      }),
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('document', { cookie: '' })

    const { api } = await import('./api')
    await api.computer(7, { includeSoftware: false })
    expect(fetchMock).toHaveBeenCalled()
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/computers/7')
    expect(url).toContain('include_software=false')
  })

  it('computerSoftware() hits /software', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ name: 'Chrome', version: '1' }],
      text: async () => '',
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('document', { cookie: '' })

    const { api } = await import('./api')
    const rows = await api.computerSoftware(12)
    expect(rows).toHaveLength(1)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/computers/12/software')
  })
})
