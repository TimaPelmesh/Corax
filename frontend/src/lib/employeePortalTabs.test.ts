import { describe, expect, it } from 'vitest'
import {
  addPortalColumn,
  addPortalRow,
  createPortalTab,
  patchPortalTab,
  removePortalColumn,
  removePortalRow,
  removePortalTab,
  setPortalCell,
} from './employeePortalTabs'

describe('employeePortalTabs', () => {
  it('creates a text tab with defaults', () => {
    const tab = createPortalTab('Phones', ['Name', 'Value'])
    expect(tab.title).toBe('Phones')
    expect(tab.kind).toBe('text')
    expect(tab.enabled).toBe(true)
    expect(tab.columns).toEqual(['Name', 'Value'])
    expect(tab.rows).toEqual([['', '']])
    expect(tab.id.length).toBeGreaterThan(3)
  })

  it('patches and removes tabs immutably', () => {
    const a = createPortalTab('A')
    const b = createPortalTab('B')
    const tabs = [a, b]
    const patched = patchPortalTab(tabs, a.id, { title: 'Renamed', enabled: false })
    expect(patched[0].title).toBe('Renamed')
    expect(patched[0].enabled).toBe(false)
    expect(tabs[0].title).toBe('A')
    expect(removePortalTab(patched, a.id).map((t) => t.id)).toEqual([b.id])
  })

  it('adds rows and columns and edits cells', () => {
    let tab = createPortalTab('Table', ['C1', 'C2'])
    tab = { ...tab, kind: 'table' }
    tab = addPortalRow(tab)
    expect(tab.rows).toHaveLength(2)
    tab = addPortalColumn(tab, 'C3')
    expect(tab.columns).toEqual(['C1', 'C2', 'C3'])
    expect(tab.rows.every((r) => r.length === 3)).toBe(true)
    tab = setPortalCell(tab, 0, 1, 'hello')
    expect(tab.rows[0][1]).toBe('hello')
    tab = removePortalRow(tab, 1)
    expect(tab.rows).toHaveLength(1)
    tab = removePortalColumn(tab, 1)
    expect(tab.columns).toEqual(['C1', 'C3'])
    expect(tab.rows[0]).toEqual(['', ''])
  })

  it('refuses to remove the last column', () => {
    let tab = createPortalTab('One', ['Only'])
    tab = removePortalColumn(tab, 0)
    expect(tab.columns).toEqual(['Only'])
  })
})
