/** Fill the view cache before a tab mounts, so the first paint is the last payload. */

import { api } from './api'
import { putCache } from './lib/viewCache'
import { readDatabasePageSize } from './pages/service-requests/shared'

export const PRINTERS_CACHE_KEY = 'printers:'
export const NETWORK_CACHE_KEY = 'network:'
export const AUDIT_HOSTS_KEY = 'audit:hosts'
export const RISK_OVERVIEW_KEY = 'risk:overview'
export const NOTES_LIST_KEY = 'notes:list'
export const WAREHOUSE_BOOT_KEY = 'warehouse:boot'

const started = new Set<string>()
const queue: Array<() => void> = []
let active = 0
const WARM_AT_ONCE = 3

function pump() {
  while (active < WARM_AT_ONCE && queue.length) {
    const job = queue.shift()
    if (!job) return
    active += 1
    job()
  }
}

function once(key: string, run: () => Promise<void>) {
  if (started.has(key)) return
  started.add(key)
  // A few tabs at once. The server coalesces identical fleet reads, so this
  // burst no longer empties the pool the way a serial chain was avoiding.
  queue.push(() => {
    run()
      .catch(() => {
        started.delete(key)
      })
      .finally(() => {
        active -= 1
        pump()
      })
  })
  pump()
}

async function warmComputers() {
  const data = await api.computers({
    view: 'list',
    skip: 0,
    limit: 100,
    sort: 'last',
    sort_dir: 'desc',
  })
  putCache('computers:1:all:last:desc::', { items: data.items, total: data.total })
}

async function warmSoftware() {
  const rows = await api.catalog('software', undefined, 5000)
  putCache('software:software:', rows)
}

async function warmRequests() {
  const pageSize = readDatabasePageSize()
  if (pageSize <= 0) return
  const data = await api.serviceRequests({ limit: pageSize, skip: 0, brief: true, counts: true })
  putCache(['requests', 'database', 1, pageSize, 0, '', 'id_desc', '', '', ''].join('|'), {
    items: data.items,
    total: data.total,
  })
}

async function warmPrinters() {
  putCache(PRINTERS_CACHE_KEY, await api.printers({ limit: 3000 }))
}

async function warmNetwork() {
  putCache(NETWORK_CACHE_KEY, await api.networkDevices({ limit: 500, sync: false }))
}

async function warmAudit() {
  putCache(AUDIT_HOSTS_KEY, await api.serverAuditHosts())
}

async function warmRisks() {
  putCache(RISK_OVERVIEW_KEY, await api.riskOverview())
}

async function warmNotes() {
  putCache(NOTES_LIST_KEY, await api.notes())
}

async function warmWarehouse() {
  const [rooms, presets] = await Promise.all([api.warehouseRooms(), api.warehousePresets()])
  putCache(WAREHOUSE_BOOT_KEY, { rooms, presets })
}

/** Warm the payload for a menu path. Safe to call on every hover. */
export function warmTab(path: string) {
  const clean = (path.split('?')[0].split('#')[0] || '/').replace(/\/$/, '') || '/'
  if (clean === '/computers' || clean.startsWith('/computers/')) once('computers', warmComputers)
  else if (clean === '/software' || clean.startsWith('/software/')) once('software', warmSoftware)
  else if (clean === '/requests' || clean.startsWith('/requests/')) once('requests', warmRequests)
  else if (clean === '/printers' || clean.startsWith('/printers/')) once('printers', warmPrinters)
  else if (clean === '/network' || (clean.startsWith('/network/') && !clean.startsWith('/network-map')))
    once('network', warmNetwork)
  else if (clean === '/server-audit' || clean.startsWith('/server-audit/')) once('audit', warmAudit)
  else if (clean === '/risks' || clean.startsWith('/risks/')) once('risks', warmRisks)
  else if (clean === '/warehouse' || clean.startsWith('/warehouse/')) once('warehouse', warmWarehouse)
  else if (clean.startsWith('/knowledge-base/notes')) once('notes', warmNotes)
}
