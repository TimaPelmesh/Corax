/** Last successful GET, so a return visit paints immediately and refreshes behind it. */

type Entry = { at: number; value: unknown }

const memory = new Map<string, Entry>()
const MAX_ENTRIES = 60

export const DASHBOARD_SUMMARY_KEY = 'dashboard:summary'
export const NAV_BADGES_KEY = 'nav:badges'
export const AUTH_USER_KEY = 'auth:user'

const PERSIST = new Set([DASHBOARD_SUMMARY_KEY, NAV_BADGES_KEY, AUTH_USER_KEY])

function persistKey(key: string) {
  return `corax.view.${key}`
}

function readPersisted<T>(key: string): T | undefined {
  if (!PERSIST.has(key) || typeof sessionStorage === 'undefined') return undefined
  try {
    const raw = sessionStorage.getItem(persistKey(key))
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

export function peekCache<T>(key: string): T | undefined {
  const hit = memory.get(key)
  if (hit) return hit.value as T
  const stored = readPersisted<T>(key)
  if (stored === undefined) return undefined
  memory.set(key, { at: Date.now(), value: stored })
  return stored
}

export function dropCache(key: string) {
  memory.delete(key)
  if (!PERSIST.has(key) || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(persistKey(key))
  } catch {
    /* private mode */
  }
}

export function putCache<T>(key: string, value: T) {
  memory.set(key, { at: Date.now(), value })
  if (PERSIST.has(key) && typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(persistKey(key), JSON.stringify(value))
    } catch {
      /* quota: the tab still has the in-memory copy */
    }
  }
  if (memory.size <= MAX_ENTRIES) return
  let oldestKey = ''
  let oldestAt = Infinity
  for (const [id, entry] of memory) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at
      oldestKey = id
    }
  }
  if (oldestKey) memory.delete(oldestKey)
}
