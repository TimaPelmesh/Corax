/** Last successful GET, so a return visit paints immediately and refreshes behind it. */

type Entry = { at: number; value: unknown }

const memory = new Map<string, Entry>()
const MAX_ENTRIES = 60

export const DASHBOARD_SUMMARY_KEY = 'dashboard:summary'
export const NAV_BADGES_KEY = 'nav:badges'

export function peekCache<T>(key: string): T | undefined {
  const hit = memory.get(key)
  return hit ? (hit.value as T) : undefined
}

export function putCache<T>(key: string, value: T) {
  memory.set(key, { at: Date.now(), value })
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
