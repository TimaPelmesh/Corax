import { useEffect, useState } from 'react'
import { api, type EmployeePortalTab } from '../api'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function newTab(title: string): EmployeePortalTab {
  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 12)
      : `tab-${Date.now().toString(36)}`
  return { id, title, kind: 'text', body: '', columns: ['Имя', 'Значение'], rows: [['', '']], enabled: true }
}

export function EmployeePortalTabsPanel() {
  const t = useT()
  const toast = useToast()
  const [tabs, setTabs] = useState<EmployeePortalTab[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .ticketHandlerConfig()
      .then((cfg) => {
        if (!cancelled) setTabs(cfg.employee_tabs ?? [])
      })
      .catch((ex) => {
        if (!cancelled) toast.error(ex instanceof Error ? ex.message : t('agentBundle.portalTabs.loadFailed'))
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
    setTabs((prev) => prev.map((tab) => (tab.id === id ? { ...tab, ...next } : tab)))
  }

  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('agentBundle.portalTabs.title')}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-[var(--color-fg-muted)]">
            {t('agentBundle.portalTabs.hint')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="app-btn app-btn-secondary"
            onClick={() => setTabs((prev) => [...prev, newTab(t('agentBundle.portalTabs.newTitle'))])}
          >
            {t('agentBundle.portalTabs.add')}
          </button>
          <button type="button" className="app-btn app-btn-primary" disabled={busy || loading} onClick={() => void save()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>

      {loading ? <p className="mt-4 text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p> : null}

      {!loading && tabs.length === 0 ? (
        <p className="mt-4 text-sm text-[var(--color-fg-muted)]">{t('agentBundle.portalTabs.empty')}</p>
      ) : null}

      <div className="mt-4 flex flex-col gap-3">
        {tabs.map((tab, index) => (
          <article key={tab.id} className="rounded-md border border-[var(--color-border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="app-input max-w-xs"
                value={tab.title}
                onChange={(e) => patch(tab.id, { title: e.target.value })}
                placeholder={t('agentBundle.portalTabs.titlePlaceholder')}
              />
              <select
                className="app-input w-auto"
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
                className="ml-auto text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-error-fg)]"
                onClick={() => setTabs((prev) => prev.filter((row) => row.id !== tab.id))}
              >
                {t('common.delete')}
              </button>
            </div>

            {tab.kind === 'table' ? (
              <div className="mt-3 overflow-x-auto">
                <table className="app-table min-w-[24rem] text-left text-sm">
                  <thead className="app-table-head">
                    <tr>
                      {tab.columns.map((col, ci) => (
                        <th key={ci}>
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
                          <td key={ci}>
                            <input
                              className="app-input min-w-[7rem]"
                              value={row[ci] ?? ''}
                              onChange={(e) => {
                                const rows = tab.rows.map((r) => [...r])
                                while (rows[ri].length < tab.columns.length) rows[ri].push('')
                                rows[ri][ci] = e.target.value
                                patch(tab.id, { rows })
                              }}
                            />
                          </td>
                        ))}
                        <td>
                          <button
                            type="button"
                            className="text-xs text-[var(--color-fg-muted)]"
                            onClick={() => patch(tab.id, { rows: tab.rows.filter((_, i) => i !== ri) })}
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    className="text-xs font-medium text-[var(--color-primary)]"
                    onClick={() =>
                      patch(tab.id, { rows: [...tab.rows, tab.columns.map(() => '')] })
                    }
                  >
                    {t('agentBundle.portalTabs.addRow')}
                  </button>
                  <button
                    type="button"
                    className="text-xs font-medium text-[var(--color-primary)]"
                    onClick={() =>
                      patch(tab.id, {
                        columns: [...tab.columns, t('agentBundle.portalTabs.columnN', { n: tab.columns.length + 1 })],
                        rows: tab.rows.map((r) => [...r, '']),
                      })
                    }
                  >
                    {t('agentBundle.portalTabs.addColumn')}
                  </button>
                </div>
              </div>
            ) : (
              <textarea
                className="app-input mt-3 min-h-28"
                value={tab.body}
                onChange={(e) => patch(tab.id, { body: e.target.value })}
                placeholder={t('agentBundle.portalTabs.bodyPlaceholder')}
              />
            )}
            <p className="mt-2 text-[11px] text-[var(--color-fg-subtle)]">
              {t('agentBundle.portalTabs.order', { n: index + 1 })}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
