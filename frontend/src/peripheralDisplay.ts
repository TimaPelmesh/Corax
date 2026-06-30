import type { PeripheralItem } from './api'

const KIND_ORDER = [
  'monitor',
  'printer',
  'keyboard',
  'mouse',
  'camera',
  'audio',
  'biometric',
  'bluetooth',
  'touchpad',
  'net',
] as const

const MONITOR_NOISE =
  /pnp|nvidia|geforce|amd|radeon|intel\(r\)?.*graphics|display adapter|mirror|dameware|remote display|basic display|generic pnp/i

const PRINTER_NOISE =
  /microsoft\s+print\s+to\s+pdf|xps\s+document\s+writer|onenote|^fax$|корневая\s+очередь\s+печати|print queue root/i

const NET_NOISE =
  /^wan\s+miniport\b|\b(pppoe|pptp|sstp|l2tp|ikev2)\b|\b(network\s+monitor|isatap|teredo|6to4)\b|\bmicrosoft\s+wi-?fi\s+direct\s+virtual\s+adapter\b|\bmicrosoft\s+kernel\s+debug\s+network\s+adapter\b|\b(hyper-?v|vmware|virtualbox)\b|\bvirtual\s+(ethernet|switch)\b|\b(tap|tunnel|loopback|vpn|wintun)\b/i

export function isNoisePeripheral(kind: string, name: string): boolean {
  const k = (kind || 'other').toLowerCase()
  const n = (name || '').trim()
  if (!n) return true
  const low = n.toLowerCase()
  if (k === 'monitor' && MONITOR_NOISE.test(low)) return true
  if (k === 'printer' && PRINTER_NOISE.test(low)) return true
  if (k === 'net' && NET_NOISE.test(low)) return true
  if ((k === 'keyboard' || k === 'mouse') && low.includes('dameware')) return true
  return false
}

function kindIndex(kind: string): number {
  const i = KIND_ORDER.indexOf(kind as (typeof KIND_ORDER)[number])
  return i >= 0 ? i : KIND_ORDER.length
}

export function preparePeripheralsForDisplay(items: PeripheralItem[]): PeripheralItem[] {
  const seen = new Set<string>()
  const out: PeripheralItem[] = []
  for (const p of items) {
    const kind = (p.kind || 'other').trim() || 'other'
    const name = (p.name || '').trim()
    if (isNoisePeripheral(kind, name)) continue
    const key = `${kind}|${name.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ kind, name })
  }
  out.sort((a, b) => {
    const dk = kindIndex(a.kind) - kindIndex(b.kind)
    if (dk !== 0) return dk
    return a.name.localeCompare(b.name, 'ru')
  })
  return out
}

export type PeripheralGroup = { kind: string; items: PeripheralItem[] }

export function groupPeripheralsForDisplay(items: PeripheralItem[]): PeripheralGroup[] {
  const prepared = preparePeripheralsForDisplay(items)
  const groups: PeripheralGroup[] = []
  for (const p of prepared) {
    const last = groups[groups.length - 1]
    if (last && last.kind === p.kind) {
      last.items.push(p)
    } else {
      groups.push({ kind: p.kind, items: [p] })
    }
  }
  return groups
}
