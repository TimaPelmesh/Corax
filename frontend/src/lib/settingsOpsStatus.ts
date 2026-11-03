/** Status math for the Wake-on-LAN and HTTPS settings screens. */

export const CERT_WARN_DAYS = 14

const DAY_MS = 86_400_000

export type CertPhase = 'missing' | 'today' | 'ok' | 'soon' | 'expired'

export type CertClock = {
  /** Whole days until expiry. 0 means later today. */
  daysLeft: number | null
  /** Whole days since expiry. 0 means it expired today. */
  overdueDays: number | null
  phase: CertPhase
}

export type HttpsPhase = 'expired' | 'restart' | 'soon' | 'live' | 'ready' | 'http'

export type PluralKind = 'one' | 'few' | 'many'

export type RelativeAge =
  | { kind: 'none' }
  | { kind: 'just' }
  | { kind: 'minutes'; n: number }
  | { kind: 'hours'; n: number }
  | { kind: 'days'; n: number }

export function certClock(notAfter: string | null | undefined, now = new Date()): CertClock {
  if (!notAfter) return { daysLeft: null, overdueDays: null, phase: 'missing' }
  const end = new Date(notAfter)
  if (Number.isNaN(end.getTime())) return { daysLeft: null, overdueDays: null, phase: 'missing' }
  const diff = end.getTime() - now.getTime()
  if (diff <= 0) {
    const overdueDays = Math.floor(-diff / DAY_MS)
    return { daysLeft: null, overdueDays: overdueDays || 0, phase: 'expired' }
  }
  if (diff < DAY_MS) return { daysLeft: 0, overdueDays: null, phase: 'today' }
  const daysLeft = Math.ceil(diff / DAY_MS)
  return {
    daysLeft,
    overdueDays: null,
    phase: daysLeft <= CERT_WARN_DAYS ? 'soon' : 'ok',
  }
}

export function httpsPhase(
  status: {
    enabled: boolean
    active: boolean
    restart_required: boolean
    files_ready: boolean
    mode: string
    not_after: string | null
  },
  now = new Date(),
): { phase: HttpsPhase; clock: CertClock } {
  const clock = certClock(status.not_after, now)
  const httpsIntent = status.mode !== 'http' || status.enabled || status.active
  if (httpsIntent && clock.phase === 'expired') return { phase: 'expired', clock }
  if (status.restart_required || status.enabled !== status.active) return { phase: 'restart', clock }
  if (status.active && (clock.phase === 'soon' || clock.phase === 'today')) return { phase: 'soon', clock }
  if (status.active) return { phase: 'live', clock }
  if (status.files_ready && status.mode !== 'http') return { phase: 'ready', clock }
  return { phase: 'http', clock }
}

export function pluralKind(n: number, locale: 'ru' | 'en'): PluralKind {
  const abs = Math.abs(Math.trunc(n))
  if (locale === 'en') return abs === 1 ? 'one' : 'many'
  const mod10 = abs % 10
  const mod100 = abs % 100
  if (mod10 === 1 && mod100 !== 11) return 'one'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'few'
  return 'many'
}

export function wakeOperatorCount(
  users: { id: number; is_superuser: boolean }[],
  wakeUserIds: number[],
): number {
  const allowed = new Set(wakeUserIds)
  let count = 0
  for (const user of users) {
    if (user.is_superuser || allowed.has(user.id)) count += 1
  }
  return count
}

export function relativeAge(iso: string | null | undefined, now = new Date()): RelativeAge {
  if (!iso) return { kind: 'none' }
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return { kind: 'none' }
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000))
  if (seconds < 60) return { kind: 'just' }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { kind: 'minutes', n: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { kind: 'hours', n: hours }
  return { kind: 'days', n: Math.floor(hours / 24) }
}
