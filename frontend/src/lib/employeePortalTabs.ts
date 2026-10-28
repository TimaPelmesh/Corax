import type { EmployeePortalTab } from '../api'

export function createPortalTab(title: string, columnDefaults: [string, string] = ['Имя', 'Значение']): EmployeePortalTab {
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 12)
      : `tab-${Date.now().toString(36)}`
  return {
    id,
    title,
    kind: 'text',
    body: '',
    columns: [...columnDefaults],
    rows: [['', '']],
    enabled: true,
  }
}

export function patchPortalTab(
  tabs: EmployeePortalTab[],
  id: string,
  next: Partial<EmployeePortalTab>,
): EmployeePortalTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...next } : tab))
}

export function removePortalTab(tabs: EmployeePortalTab[], id: string): EmployeePortalTab[] {
  return tabs.filter((tab) => tab.id !== id)
}

export function addPortalRow(tab: EmployeePortalTab): EmployeePortalTab {
  return {
    ...tab,
    rows: [...tab.rows, tab.columns.map(() => '')],
  }
}

export function addPortalColumn(tab: EmployeePortalTab, columnTitle: string): EmployeePortalTab {
  return {
    ...tab,
    columns: [...tab.columns, columnTitle],
    rows: tab.rows.map((row) => [...row, '']),
  }
}

export function removePortalColumn(tab: EmployeePortalTab, columnIndex: number): EmployeePortalTab {
  if (tab.columns.length <= 1 || columnIndex < 0 || columnIndex >= tab.columns.length) return tab
  return {
    ...tab,
    columns: tab.columns.filter((_, i) => i !== columnIndex),
    rows: tab.rows.map((row) => row.filter((_, i) => i !== columnIndex)),
  }
}

export function removePortalRow(tab: EmployeePortalTab, rowIndex: number): EmployeePortalTab {
  return {
    ...tab,
    rows: tab.rows.filter((_, i) => i !== rowIndex),
  }
}

export function setPortalCell(
  tab: EmployeePortalTab,
  rowIndex: number,
  columnIndex: number,
  value: string,
): EmployeePortalTab {
  const rows = tab.rows.map((row) => [...row])
  if (!rows[rowIndex]) return tab
  while (rows[rowIndex].length < tab.columns.length) rows[rowIndex].push('')
  rows[rowIndex][columnIndex] = value
  return { ...tab, rows }
}
