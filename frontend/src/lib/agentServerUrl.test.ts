import { describe, expect, it } from 'vitest'
import { buildAgentServerUrl, schemeFromTls } from './agentServerUrl'

describe('buildAgentServerUrl', () => {
  it('stamps http by default', () => {
    expect(buildAgentServerUrl('192.168.1.10', '3000')).toBe('http://192.168.1.10:3000')
  })

  it('stamps https when scheme is https', () => {
    expect(buildAgentServerUrl('corax.local', '3000', 'https')).toBe('https://corax.local:3000')
  })
})

describe('schemeFromTls', () => {
  it('prefers agent_scheme from API', () => {
    expect(schemeFromTls('https')).toBe('https')
    expect(schemeFromTls('http')).toBe('http')
  })

  it('falls back to active/enabled', () => {
    expect(schemeFromTls(undefined, true, false)).toBe('https')
    expect(schemeFromTls(undefined, false, true)).toBe('https')
    expect(schemeFromTls(undefined, false, false)).toBe('http')
  })
})
