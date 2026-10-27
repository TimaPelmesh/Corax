import { describe, expect, it } from 'vitest'
import { REMOTE_CONNECT_METHODS, rdpLaunchUri, rdpTargetFor, sanitizeRdpTarget } from './remoteConnect'

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

  it('builds a protocol URI for mstsc, not a file', () => {
    expect(rdpLaunchUri('PC-LAB-01')).toBe('corax-rdp:PC-LAB-01')
    expect(rdpLaunchUri('pc; calc')).toBeNull()
  })

  it('offers Assist and RDP now, DameWare later', () => {
    expect(REMOTE_CONNECT_METHODS.find((m) => m.id === 'assist')?.available).toBe(true)
    expect(REMOTE_CONNECT_METHODS.find((m) => m.id === 'rdp')?.available).toBe(true)
    expect(REMOTE_CONNECT_METHODS.find((m) => m.id === 'dameware')?.available).toBe(false)
  })
})
