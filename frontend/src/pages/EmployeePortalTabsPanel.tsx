import { useEffect, useState } from 'react'
import { api, type EmployeePortalTab } from '../api'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { Skeleton } from '../components/Skeleton'
import { AppFold } from '../components/ui/AppFold'
import { StatusPill } from '../components/ui/StatusPill'
import { useT } from '../i18n/LocaleContext'
import {
  addPortalColumn,
  addPortalRow,
  createPortalTab,
  patchPortalTab,
  removePortalRow,
  removePortalTab,
  setPortalCell,
} from '../lib/employeePortalTabs'
import { useToast } from '../ToastContext'

export function EmployeePortalTabsPanel() {
  const t = useT()
  const toast = useToast()
  const { ask, dialog } = useConfirmDialog()
  const [tabs, setTabs] = useState<EmployeePortalTab[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .ticketHandlerConfig()
      .then((cfg) => {
        if (!cancelled) {
          setTabs(cfg.employee_tabs ?? [])
          setLoadError(null)
        }
      })
      .catch((ex) => {
        if (!cancelled) {
          const msg = ex instanceof Error ? ex.message : t('agentBundle.portalTabs.loadFailed')
          setLoadError(msg)
          toast.error(msg)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [t, toast])

  async function save() {
    setBusy(true)
    try {
      const out = await api.updateTicketHandlerConfig({ employee_tabs: tabs })
      setTabs(out.employee_tabs ?? tabs)
      toast.ok(t('agentBundle.portalTabs.saved'))
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : t('agentBundle.portalTabs.saveFailed'))
    } finally {
      setBusy(false)
    }
  }

  function patch(id: string, next: Partial<EmployeePortalTab>) {
    setTabs((prev) => patchPortalTab(prev, id, next))
  }

  async function removeTab(id: string, title: string) {
    const ok = await ask({
      title: t('common.delete'),
      body: t('agentBundle.portalTabs.deleteConfirm', { title: title || t('agentBundle.portalTabs.newTitle') }),
      confirmLabel: t('common.delete'),
      tone: 'danger',
    })
    if (!ok) return
    setTabs((prev) => removePortalTab(prev, id))
  }

  return (
    <section className="app-panel">
      {dialog}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('agentBundle.portalTabs.title')}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-fg-muted)]">
            {t('agentBundle.portalTabs.hint')}
          </p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
          <button
            type="button"
            className="app-btn app-btn-secondary w-full sm:w-auto"
            onClick={() => setTabs((prev) => [...prev, createPortalTab(t('agentBundle.portalTabs.newTitle'))])}
          >
            {t('agentBundle.portalTabs.add')}
          </button>
          <button
            type="button"
            className="app-btn app-btn-primary w-full sm:w-auto"
            disabled={busy || loading}
            onClick={() => void save()}
          >
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="mt-4 space-y-2" role="status" aria-busy="true">
          <Skeleton className="h-12 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : null}

      {loadError && !loading ? (
        <div className="app-alert app-alert-warning mt-4 text-sm">{loadError}</div>
      ) : null}

      {!loading && tabs.length === 0 ? (
        <div className="app-empty-state mt-4">
          <p>{t('agentBundle.portalTabs.empty')}</p>
          <button
            type="button"
            className="app-btn app-btn-primary mt-3 w-full sm:w-auto"
            onClick={() => setTabs((prev) => [...prev, createPortalTab(t('agentBundle.portalTabs.newTitle'))])}
          >
            {t('agentBundle.portalTabs.add')}
          </button>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {tabs.map((tab, index) => (
          <AppFold
            key={tab.id}
            className="!shadow-none"
            defaultOpen={index === 0 || tabs.length === 1}
            title={
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-medium text-[var(--color-fg)]">
                  {tab.title.trim() || t('agentBundle.portalTabs.newTitle')}
                </span>
                <StatusPill tone={tab.enabled ? 'success' : 'neutral'}>
                  {tab.enabled ? t('agentBundle.portalTabs.enabled') : t('agentBundle.portalTabs.disabled')}
                </StatusPill>
                <span className="text-[11px] font-normal text-[var(--color-fg-subtle)]">
                  {tab.kind === 'table' ? t('agentBundle.portalTabs.kindTable') : t('agentBundle.portalTabs.kindText')}
                  {' · '}
                  {t('agentBundle.portalTabs.order', { n: index + 1 })}
                </span>
              </span>
            }
          >
            <div className="space-y-3 pt-1">
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <input
                  className="app-input w-full sm:max-w-xs"
                  value={tab.title}
                  onChange={(e) => patch(tab.id, { title: e.target.value })}
                  placeholder={t('agentBundle.portalTabs.titlePlaceholder')}
                />
                <select
                  className="app-input w-full sm:w-auto"
                  value={tab.kind === 'table' ? 'table' : 'text'}
                  onChange={(e) => patch(tab.id, { kind: e.target.value === 'table' ? 'table' : 'text' })}
                >
                  <option value="text">{t('agentBundle.portalTabs.kindText')}</option>
                  <option value="table">{t('agentBundle.portalTabs.kindTable')}</option>
                </select>
                <label className="flex items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
                  <input
                    type="checkbox"
                    checked={tab.enabled}
                    onChange={(e) => patch(tab.id, { enabled: e.target.checked })}
                  />
                  {t('agentBundle.portalTabs.enabled')}
                </label>
                <button
                  type="button"
                  className="text-xs font-medium text-[var(--color-error-fg)] hover:underline sm:ml-auto"
                  onClick={() => void removeTab(tab.id, tab.title)}
                >
                  {t('common.delete')}
                </button>
              </div>

              {tab.kind === 'table' ? (
                <div className="app-table-shell overflow-hidden rounded-xl border border-[var(--color-border)]">
                  <div className="overflow-x-auto">
                    <table className="app-table min-w-[24rem] text-left text-sm">
                      <thead className="app-table-head">
                        <tr>
                          {tab.columns.map((col, ci) => (
                            <th key={ci} className="px-2 py-2">
                              <input
                                className="app-input min-w-[7rem]"
                                value={col}
                                onChange={(e) => {
                                  const columns = [...tab.columns]
                                  columns[ci] = e.target.value
                                  patch(tab.id, { columns })
                                }}
                              />
                            </th>
                          ))}
                          <th className="w-10" />
                        </tr>
                      </thead>
                      <tbody>
                        {tab.rows.map((row, ri) => (
                          <tr key={ri} className="app-table-row">
                            {tab.columns.map((_, ci) => (
                              <td key={ci} className="px-2 py-1.5">
                                <input
                                  className="app-input min-w-[7rem]"
                                  value={row[ci] ?? ''}
                                  onChange={(e) => {
                                    const value = e.target.value
                                    setTabs((prev) =>
                                      prev.map((row) =>
                                        row.id === tab.id ? setPortalCell(row, ri, ci, value) : row,
                                      ),
                                    )
                                  }}
                                />
                              </td>
                            ))}
                            <td className="px-2">
                              <button
                                type="button"
                                className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-error-fg)]"
                                onClick={() =>
                                  setTabs((prev) =>
                                    prev.map((row) =>
                                      row.id === tab.id ? removePortalRow(row, ri) : row,
                                    ),
                                  )
                                }
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex flex-col gap-2 border-t border-[var(--color-border)] p-2 sm:flex-row">
                    <button
                      type="button"
                      className="app-btn app-btn-secondary w-full !min-h-0 text-xs sm:w-auto"
                      onClick={() =>
                        setTabs((prev) =>
                          prev.map((row) => (row.id === tab.id ? addPortalRow(row) : row)),
                        )
                      }
                    >
                      {t('agentBundle.portalTabs.addRow')}
                    </button>
                    <button
                      type="button"
                      className="app-btn app-btn-secondary w-full !min-h-0 text-xs sm:w-auto"
                      onClick={() =>
                        setTabs((prev) =>
                          prev.map((row) =>
                            row.id === tab.id
                              ? addPortalColumn(
                                  row,
                                  t('agentBundle.portalTabs.columnN', { n: row.columns.length + 1 }),
                                )
                              : row,
                          ),
                        )
                      }
                    >
                      {t('agentBundle.portalTabs.addColumn')}
                    </button>
                  </div>
                </div>
              ) : (
                <textarea
                  className="app-input min-h-28"
                  value={tab.body}
                  onChange={(e) => patch(tab.id, { body: e.target.value })}
                  placeholder={t('agentBundle.portalTabs.bodyPlaceholder')}
                />
              )}
            </div>
          </AppFold>
        ))}
      </div>
    </section>
  )
}
