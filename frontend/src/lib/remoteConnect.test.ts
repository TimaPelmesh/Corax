import { describe, expect, it } from 'vitest'
import { buildRdpFile, rdpFileName, rdpTargetFor, sanitizeRdpTarget } from './remoteConnect'

describe('remoteConnect', () => {
  it('accepts a PC name and a LAN IP', () => {
    expect(sanitizeRdpTarget('PC-LAB-01')).toBe('PC-LAB-01')
    expect(sanitizeRdpTarget('pc.office.lan')).toBe('pc.office.lan')
    expect(sanitizeRdpTarget('10.20.30.40')).toBe('10.20.30.40')
    expect(rdpTargetFor('PC-LAB-01', '10.0.0.8')).toBe('PC-LAB-01')
    expect(rdpTargetFor('', '10.0.0.8')).toBe('10.0.0.8')
  })

  it('rejects injection and loopback', () => {
    expect(sanitizeRdpTarget('pc; calc')).toBeNull()
    expect(sanitizeRdpTarget('pc & notepad')).toBeNull()
    expect(sanitizeRdpTarget('127.0.0.1')).toBeNull()
    expect(sanitizeRdpTarget('0.0.0.0')).toBeNull()
    expect(sanitizeRdpTarget('..\\evil')).toBeNull()
    expect(sanitizeRdpTarget('user:pass@pc')).toBeNull()
  })

  it('builds an rdp file without credentials', () => {
    const body = buildRdpFile('PC-LAB-01')
    expect(body).toContain('full address:s:PC-LAB-01')
    expect(body).toContain('prompt for credentials:i:1')
    expect(body.toLowerCase()).not.toContain('password')
    expect(body.toLowerCase()).not.toContain('username')
    expect(rdpFileName('PC-LAB-01')).toBe('corax-PC-LAB-01.rdp')
  })
})
