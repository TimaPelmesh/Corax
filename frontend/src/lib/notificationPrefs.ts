export type NotificationPrefs = {
  enabled: boolean
  /** Заявки, принятые к сведению — точка не горит. */
  readIds: number[]
}

const PREFIX = 'corax.notifications.v1:'

function keyFor(userId: number): string {
  return `${PREFIX}${userId}`
}

export function readNotificationPrefs(userId: number): NotificationPrefs {
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return { enabled: true, readIds: [] }
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>
    return {
      enabled: parsed.enabled !== false,
      readIds: Array.isArray(parsed.readIds)
        ? parsed.readIds.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
        : [],
    }
  } catch {
    return { enabled: true, readIds: [] }
  }
}

export function writeNotificationPrefs(userId: number, prefs: NotificationPrefs): void {
  try {
    localStorage.setItem(
      keyFor(userId),
      JSON.stringify({
        enabled: prefs.enabled,
        readIds: [...new Set(prefs.readIds)].slice(-200),
      }),
    )
  } catch {
    /* ignore */
  }
}

export function unreadAssigned(
  items: { id: number }[],
  prefs: NotificationPrefs,
): { id: number }[] {
  if (!prefs.enabled) return []
  const read = new Set(prefs.readIds)
  return items.filter((x) => !read.has(x.id))
}
