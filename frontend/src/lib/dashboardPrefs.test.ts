import { afterEach, describe, expect, it } from 'vitest'
import {
  DASHBOARD_WIDGETS_KEY,
  DEFAULT_WIDGETS,
  readWidgets,
  writeWidgets,
} from './dashboardPrefs'

afterEach(() => {
  localStorage.removeItem(DASHBOARD_WIDGETS_KEY)
})

describe('dashboardPrefs', () => {
  it('returns default widgets when empty', () => {
    expect(readWidgets()).toEqual(DEFAULT_WIDGETS)
  })

  it('merges partial widget prefs with defaults', () => {
    localStorage.setItem(
      DASHBOARD_WIDGETS_KEY,
      JSON.stringify({ 'dist.by_os': false, 'list.upcoming_notes': false }),
    )
    const w = readWidgets()
    expect(w['dist.by_os']).toBe(false)
    expect(w['list.upcoming_notes']).toBe(false)
    expect(w['dist.by_manufacturer']).toBe(true)
  })

  it('ignores unknown legacy widget keys', () => {
    localStorage.setItem(
      DASHBOARD_WIDGETS_KEY,
      JSON.stringify({ 'list.top_users': true, 'dist.by_os': false }),
    )
    const w = readWidgets()
    expect(w['dist.by_os']).toBe(false)
    expect('list.top_users' in w).toBe(false)
  })

  it('persists widgets round-trip', () => {
    const next = { ...DEFAULT_WIDGETS, 'list.upcoming_notes': false }
    writeWidgets(next)
    expect(readWidgets()['list.upcoming_notes']).toBe(false)
  })
})
