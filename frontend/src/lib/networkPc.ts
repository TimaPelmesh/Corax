import type { NetworkDevice } from '../api'

const GEAR = new Set([
  'printer',
  'switch',
  'router',
  'ap',
  'firewall',
  'nas',
  'voip',
  'ups',
  'camera',
  'modem',
  'gateway',
  'dns',
  'infra',
  'controller',
  'server',
  'vm',
])

/** A workstation row: inventory PC, or a network row tied to a computer. Gear and Zabbix stubs are not. */
export function isWorkstation(row: NetworkDevice): boolean {
  const kind = (row.role || row.device_type || '').toLowerCase()
  if (GEAR.has(kind)) return false
  if (kind === 'host') return true
  if ((row.hostname || '').trim().startsWith('ПК ·')) return true
  return Boolean(row.computer_id)
}

export function pcLacksAgent(row: NetworkDevice): boolean {
  return !row.agent_installed && isWorkstation(row)
}
