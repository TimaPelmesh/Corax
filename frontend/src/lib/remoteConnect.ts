/** Methods we can offer from a ticket or PC card. Only RDP launches today. */

export type RemoteConnectMethodId = 'rdp' | 'assist' | 'dameware'

export type RemoteConnectMethod = {
  id: RemoteConnectMethodId
  available: boolean
}

export const REMOTE_CONNECT_METHODS: readonly RemoteConnectMethod[] = [
  { id: 'rdp', available: true },
  { id: 'assist', available: false },
  { id: 'dameware', available: false },
]

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function octetOk(n: number): boolean {
  return n >= 0 && n <= 255
}

/** Hostname or IPv4 only. No credentials, no extra mstsc switches. */
export function sanitizeRdpTarget(raw: string): string | null {
  const value = (raw || '').trim()
  if (!value || value.length > 255) return null
  if (/[\s\\/"'`;|$&<>]/.test(value)) return null
  if (value.includes('..')) return null
  const ip = IPV4_RE.exec(value)
  if (ip) {
    const parts = [ip[1], ip[2], ip[3], ip[4]].map(Number)
    if (!parts.every(octetOk)) return null
    if (parts[0] === 0 || parts[0] === 127 || parts[0] >= 224) return null
    return parts.join('.')
  }
  if (!HOST_RE.test(value)) return null
  return value
}

export function rdpTargetFor(hostname?: string | null, ip?: string | null): string | null {
  return sanitizeRdpTarget(hostname || '') || sanitizeRdpTarget(ip || '')
}

export const RDP_PROTOCOL = 'corax-rdp'

export function rdpLaunchUri(target: string): string | null {
  const host = sanitizeRdpTarget(target)
  if (!host) return null
  return `${RDP_PROTOCOL}:${host}`
}

/** Opens the Windows Remote Desktop window with the PC name filled in. Does not ping. */
export function launchRdpSession(target: string): { ok: true; target: string; uri: string } | { ok: false } {
  const uri = rdpLaunchUri(target)
  const host = sanitizeRdpTarget(target)
  if (!uri || !host) return { ok: false }
  window.location.assign(uri)
  return { ok: true, target: host, uri }
}
