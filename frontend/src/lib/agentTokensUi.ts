import type { AgentTokenRow } from '../api'

/** Active (non-revoked) agent tokens for the admin table. */
export function activeAgentTokens(rows: AgentTokenRow[]): AgentTokenRow[] {
  return rows.filter((row) => !row.revoked_at)
}

export function agentTokenIsActive(row: AgentTokenRow): boolean {
  return !row.revoked_at
}
