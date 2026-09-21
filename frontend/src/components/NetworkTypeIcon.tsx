import type { ComponentType, ReactNode } from 'react'
import {
  IconAccessPoint,
  IconCloud,
  IconFirewall,
  IconLogo,
  IconNas,
  IconPcs,
  IconPrinter,
  IconRouter,
  IconServer,
  IconSwitch,
  IconVm,
} from './icons'

type IconCmp = ComponentType<{ className?: string }>

const BY_TYPE: Record<string, IconCmp> = {
  switch: IconSwitch,
  controller: IconSwitch,
  router: IconRouter,
  gateway: IconRouter,
  modem: IconRouter,
  firewall: IconFirewall,
  ap: IconAccessPoint,
  server: IconServer,
  nas: IconNas,
  printer: IconPrinter,
  cloud: IconCloud,
  corax: IconLogo,
  vm: IconVm,
  pc: IconPcs,
  host: IconPcs,
  computer: IconPcs,
}

export const NETWORK_DEVICE_TYPE_OPTIONS = [
  'switch',
  'router',
  'gateway',
  'ap',
  'firewall',
  'controller',
  'server',
  'vm',
  'host',
  'printer',
  'nas',
  'voip',
  'ups',
  'camera',
  'modem',
  'unknown',
] as const

export function NetworkTypeIcon({
  type,
  className = 'h-5 w-5',
}: {
  type?: string | null
  className?: string
}): ReactNode {
  const Icon = BY_TYPE[(type || '').toLowerCase()] || IconPcs
  return <Icon className={className} />
}
