/** Parse agent v3 `extended` block for inline display in computer summary. */

export type PhysicalDiskRow = {
  name: string
  media: string | null
  health: string | null
  sizeGb: number | null
}

export type OfficeSummary = {
  label: string
  path?: string | null
}

export type ParsedAgentExtras = {
  primaryUser: string | null
  gateways: string[]
  dnsV4: string[]
  wifiSsid: string | null
  physicalDisks: PhysicalDiskRow[]
  patchIds: string[]
  patchTotal: number
  office: OfficeSummary[]
  securityHint: string | null
  batteryPercent: number | null
  gpus: string[]
  localAdmins: string[]
  batteryHealthPercent: number | null
  lastHotfix: string | null
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function s(v: unknown): string | null {
  if (v == null || v === '') return null
  return String(v)
}

function isUsefulDns(addr: string) {
  const a = addr.trim().toLowerCase()
  if (!a || a.startsWith('127.') || a.startsWith('fe80:') || a.startsWith('fec0:') || a === '::1') return false
  return true
}

const OFFICE_VER: Record<string, string> = {
  '14.0': 'Office 2010',
  '15.0': 'Office 2013',
  '16.0': 'Office 2016 / 365',
}

export function parseAgentExtras(ext: Record<string, unknown> | null | undefined): ParsedAgentExtras | null {
  if (!ext || Object.keys(ext).length === 0) return null

  const sys = asObj(ext.system)
  const net = asObj(ext.network)
  const battery = asObj(ext.battery)
  const tpm = asObj(ext.tpm)

  let dnsV4 = asArr(net?.dns_v4).map(s).filter((x): x is string => Boolean(x))
  const dnsLegacy = asArr(net?.dns).map(s).filter((x): x is string => typeof x === 'string' && isUsefulDns(x))
  if (!dnsV4.length) dnsV4 = dnsLegacy.filter((x) => !x.includes(':'))

  const gateways = asArr(net?.gateways).map(s).filter((x): x is string => Boolean(x))
  const wifi = asArr(net?.wifi)
  const wifiSsid = wifi.length ? s(asObj(wifi[0])?.ssid) : null

  const physicalDisks = asArr(ext.physical_disks).map((row) => {
    const r = asObj(row)
    if (!r) return null
    return {
      name: s(r.friendly_name) ?? 'Диск',
      media: s(r.media_type),
      health: s(r.health_status),
      sizeGb: typeof r.size_gb === 'number' ? r.size_gb : null,
    }
  }).filter((x): x is PhysicalDiskRow => x != null)

  const patches = asArr(ext.patches)
  const patchIds = patches
    .map((p) => s(asObj(p)?.hotfix_id))
    .filter((x): x is string => Boolean(x))
    .slice(0, 16)

  const office: OfficeSummary[] = []
  const installs = asArr(ext.office_installs)
  if (installs.length) {
    for (const row of installs) {
      const r = asObj(row)
      if (!r) continue
      const ver = s(r.version) ?? ''
      office.push({
        label: s(r.label) ?? OFFICE_VER[ver] ?? (ver ? `Office ${ver}` : 'Office'),
        path: s(r.install_root),
      })
    }
  } else {
    for (const row of asArr(ext.office)) {
      const r = asObj(row)
      if (!r?.install_root && !r?.version) continue
      if (r.product && !r.install_root) continue
      const ver = s(r.version) ?? ''
      office.push({
        label: OFFICE_VER[ver] ?? (ver ? `Office ${ver}` : 'Office'),
        path: s(r.install_root),
      })
    }
  }

  const av = asArr(ext.antivirus)
  const avName = av.length ? s(asObj(av[0])?.display_name) : null
  const secParts: string[] = []
  if (tpm?.present === true) secParts.push('TPM')
  if (ext.secure_boot_enabled === true) secParts.push('Secure Boot')
  if (ext.pending_reboot === true) secParts.push('Pending reboot')
  if (avName) secParts.push(avName)

  const gpus = asArr(ext.gpus)
    .map((row) => {
      const r = asObj(row)
      if (!r) return null
      const name = s(r.name)
      if (!name) return null
      const vram = typeof r.vram_gb === 'number' ? ` ${r.vram_gb} GB` : ''
      const drv = s(r.driver_version)
      return drv ? `${name}${vram} · ${drv}` : `${name}${vram}`
    })
    .filter((x): x is string => Boolean(x))

  const localAdmins = asArr(ext.local_admins)
    .map(s)
    .filter((x): x is string => Boolean(x))
    .slice(0, 12)

  const batteryHealth =
    typeof asObj(ext.battery_health)?.health_percent === 'number'
      ? (asObj(ext.battery_health)!.health_percent as number)
      : null

  return {
    primaryUser: s(sys?.primary_user),
    gateways,
    dnsV4,
    wifiSsid,
    physicalDisks,
    patchIds,
    patchTotal: patches.length,
    office,
    securityHint: secParts.length ? secParts.join(' · ') : null,
    batteryPercent:
      typeof battery?.estimated_charge_remaining === 'number'
        ? battery.estimated_charge_remaining
        : typeof asObj(ext.battery_health)?.charge_remaining_percent === 'number'
          ? (asObj(ext.battery_health)!.charge_remaining_percent as number)
          : null,
    gpus,
    localAdmins,
    batteryHealthPercent: batteryHealth,
    lastHotfix: s(ext.last_hotfix_id),
  }
}
