import { describe, expect, it } from 'vitest'
import { certClock, httpsPhase, pluralKind, relativeAge, wakeOperatorCount } from './settingsOpsStatus'

const NOW = new Date('2026-06-01T00:00:00Z')

describe('certClock', () => {
  it('counts whole days and warns inside two weeks', () => {
    expect(certClock('2026-06-15T00:00:00Z', NOW)).toMatchObject({ daysLeft: 14, phase: 'soon' })
    expect(certClock('2026-06-15T01:00:00Z', NOW)).toMatchObject({ daysLeft: 15, phase: 'ok' })
    expect(certClock('2026-06-01T12:00:00Z', NOW)).toMatchObject({ daysLeft: 0, phase: 'today' })
  })

  it('counts overdue days after expiry', () => {
    expect(certClock('2026-05-29T00:00:00Z', NOW)).toMatchObject({ overdueDays: 3, phase: 'expired' })
    expect(certClock('2026-06-01T00:00:00Z', NOW)).toMatchObject({ overdueDays: 0, phase: 'expired' })
  })

  it('treats a missing or broken date as no certificate', () => {
    expect(certClock(null, NOW).phase).toBe('missing')
    expect(certClock('not-a-date', NOW).phase).toBe('missing')
  })
})

describe('httpsPhase', () => {
  const base = {
    enabled: true,
    active: true,
    restart_required: false,
    files_ready: true,
    mode: 'local_ca',
    not_after: '2026-12-01T00:00:00Z',
  }

  it('says the panel is live when the process serves a healthy certificate', () => {
    expect(httpsPhase(base, NOW).phase).toBe('live')
  })

  it('warns when the certificate is inside the warning window', () => {
    expect(httpsPhase({ ...base, not_after: '2026-06-10T00:00:00Z' }, NOW).phase).toBe('soon')
  })

  it('puts an expired certificate ahead of a pending restart', () => {
    expect(
      httpsPhase({ ...base, restart_required: true, not_after: '2026-05-01T00:00:00Z' }, NOW).phase,
    ).toBe('expired')
  })

  it('asks for a restart when config and process disagree', () => {
    expect(httpsPhase({ ...base, enabled: true, active: false }, NOW).phase).toBe('restart')
  })

  it('treats plain HTTP as a working state', () => {
    expect(
      httpsPhase(
        { ...base, enabled: false, active: false, mode: 'http', files_ready: false, not_after: null },
        NOW,
      ).phase,
    ).toBe('http')
  })

  it('says the certificate is ready when files exist but HTTPS is still off', () => {
    expect(
      httpsPhase({ ...base, enabled: false, active: false, mode: 'local_ca' }, NOW).phase,
    ).toBe('ready')
  })
})

describe('pluralKind', () => {
  it('uses Russian day forms', () => {
    expect(pluralKind(1, 'ru')).toBe('one')
    expect(pluralKind(3, 'ru')).toBe('few')
    expect(pluralKind(11, 'ru')).toBe('many')
    expect(pluralKind(22, 'ru')).toBe('few')
  })

  it('uses English one and many', () => {
    expect(pluralKind(1, 'en')).toBe('one')
    expect(pluralKind(5, 'en')).toBe('many')
  })
})

describe('wakeOperatorCount', () => {
  it('counts admins once even when they are also checked', () => {
    const users = [
      { id: 1, is_superuser: true },
      { id: 2, is_superuser: false },
      { id: 3, is_superuser: false },
    ]
    expect(wakeOperatorCount(users, [1, 2])).toBe(2)
    expect(wakeOperatorCount(users, [])).toBe(1)
  })
})

describe('relativeAge', () => {
  it('buckets a timestamp', () => {
    expect(relativeAge('2026-06-01T00:00:30Z', NOW).kind).toBe('just')
    expect(relativeAge('2026-05-31T23:00:00Z', NOW)).toEqual({ kind: 'hours', n: 1 })
    expect(relativeAge(null, NOW)).toEqual({ kind: 'none' })
  })
})
