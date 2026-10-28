import { describe, expect, it } from 'vitest'
import type { AgentTokenRow } from '../api'
import { activeAgentTokens, agentTokenIsActive } from './agentTokensUi'

function row(partial: Partial<AgentTokenRow> & Pick<AgentTokenRow, 'id'>): AgentTokenRow {
  return {
    public_id_prefix: 'abc',
    label: null,
    allowed_hostname: null,
    created_at: '2026-01-01T00:00:00Z',
    revoked_at: null,
    last_used_at: null,
    ...partial,
  }
}

describe('agentTokensUi', () => {
  it('filters active tokens', () => {
    const rows = [
      row({ id: 1 }),
      row({ id: 2, revoked_at: '2026-02-01T00:00:00Z' }),
      row({ id: 3, label: 'ok' }),
    ]
    expect(activeAgentTokens(rows).map((r) => r.id)).toEqual([1, 3])
    expect(agentTokenIsActive(rows[0])).toBe(true)
    expect(agentTokenIsActive(rows[1])).toBe(false)
  })
})
