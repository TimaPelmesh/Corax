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

/** Standard .rdp file: address only. Windows prompts for credentials. */
export function buildRdpFile(target: string): string {
  const host = sanitizeRdpTarget(target)
  if (!host) throw new Error('invalid-rdp-target')
  return [
    'full address:s:' + host,
    'prompt for credentials:i:1',
    'authentication level:i:2',
    'negotiate security layer:i:1',
    'enablecredsspsupport:i:1',
    'promptcredentialonce:i:0',
    'redirectclipboard:i:1',
    'redirectdrives:i:0',
    'redirectprinters:i:0',
    'redirectcomports:i:0',
    'redirectsmartcards:i:0',
    'displayconnectionbar:i:1',
    'screen mode id:i:2',
    '',
  ].join('\r\n')
}

export function rdpFileName(target: string): string {
  const host = sanitizeRdpTarget(target) || 'pc'
  return `corax-${host.replace(/[^A-Za-z0-9._-]/g, '_')}.rdp`
}

export function downloadRdpFile(target: string): { ok: true; target: string } | { ok: false } {
  const host = sanitizeRdpTarget(target)
  if (!host) return { ok: false }
  const blob = new Blob([buildRdpFile(host)], { type: 'application/x-rdp' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = rdpFileName(host)
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  return { ok: true, target: host }
}
