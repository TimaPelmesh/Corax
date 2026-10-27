/** Build agent INVENTORY_SERVER URL. Scheme must match the server listen mode. */

export type AgentUrlScheme = 'http' | 'https'

export function buildAgentServerUrl(
  host: string,
  port: string,
  scheme: AgentUrlScheme = 'http',
): string {
  const h = host.trim()
  const p = (port.trim() || '3000').replace(/[^\d]/g, '') || '3000'
  const s = scheme === 'https' ? 'https' : 'http'
  if (!h) return `${s}://…:${p}`
  return `${s}://${h}:${p}`
}

export function schemeFromTls(agentScheme: string | null | undefined, active?: boolean, enabled?: boolean): AgentUrlScheme {
  const raw = (agentScheme || '').trim().toLowerCase()
  if (raw === 'https' || raw === 'http') return raw
  if (active || enabled) return 'https'
  return 'http'
}
