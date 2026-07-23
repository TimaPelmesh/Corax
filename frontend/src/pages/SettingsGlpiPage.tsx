import { useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type ServiceRequestRow } from '../api'
import { useAuth } from '../AuthContext'
import { IconPcs, IconTicket } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function downloadText(filename: string, text: string, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function csvEscape(v: string) {
  return `"${v.replace(/"/g, '""')}"`
}

function exportRequestsJsonFile(items: ServiceRequestRow[], total: number) {
  const payload = { exported_at: new Date().toISOString(), total, items }
  downloadText(
    `service_requests_export_${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2),
    'application/json;charset=utf-8',
  )
}

function exportRequestsCsvFile(items: ServiceRequestRow[]) {
  const sep = ';'
  const headers = [
    'id',
    'title',
    'location',
    'status',
    'priority',
    'created_by',
    'assignees',
    'computer',
    'opened_at',
    'planned_close_at',
    'closed_at',
    'created_at',
    'updated_at',
    'description',
  ]
  const lines = [headers.join(sep)]
  for (const r of items) {
    lines.push(
      [
        String(r.id),
        csvEscape(r.title ?? ''),
        csvEscape(r.location ?? ''),
        csvEscape(r.status ?? ''),
        csvEscape(r.priority ?? ''),
        csvEscape(r.created_by_username ?? ''),
        csvEscape((r.assignee_usernames ?? []).join('; ')),
        csvEscape(r.computer_hostname ?? ''),
        csvEscape(r.opened_at ?? ''),
        csvEscape(r.planned_close_at ?? ''),
        csvEscape(r.closed_at ?? ''),
        csvEscape(r.created_at ?? ''),
        csvEscape(r.updated_at ?? ''),
        csvEscape((r.description ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')),
      ].join(sep),
    )
  }
  downloadText(
    `service_requests_export_${new Date().toISOString().slice(0, 10)}.csv`,
    `\uFEFF${lines.join('\r\n')}`,
    'text/csv;charset=utf-8',
  )
}

export function SettingsGlpiPage() {
  const t = useT()
  const toast = useToast()
  const { user, loading: authLoading } = useAuth()
  const glpiPcsImportRef = useRef<HTMLInputElement | null>(null)
  const glpiRequestsImportRef = useRef<HTMLInputElement | null>(null)
  const requestsJsonImportRef = useRef<HTMLInputElement | null>(null)
  const [pcsImportBusy, setPcsImportBusy] = useState(false)
  const [pcsExportBusy, setPcsExportBusy] = useState(false)
  const [pcsExportGlpiBusy, setPcsExportGlpiBusy] = useState(false)
  const [reqImportGlpiBusy, setReqImportGlpiBusy] = useState(false)
  const [reqImportJsonBusy, setReqImportJsonBusy] = useState(false)
  const [reqExportJsonBusy, setReqExportJsonBusy] = useState(false)
  const [reqExportCsvBusy, setReqExportCsvBusy] = useState(false)
  const [reqExportGlpiBusy, setReqExportGlpiBusy] = useState(false)

  if (authLoading) {
    return <p className="text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  async function exportParkCsv() {
    setPcsExportBusy(true)
    try {
      await api.exportComputersCsv()
      toast.ok(t('settingsGlpi.exportCsvReady'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.exportCsvFailed'))
    } finally {
      setPcsExportBusy(false)
    }
  }

  async function exportParkGlpiCsv() {
    setPcsExportGlpiBusy(true)
    try {
      await api.exportGlpiPcsCsv()
      toast.ok(t('settingsGlpi.exportGlpiReady'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.exportGlpiFailed'))
    } finally {
      setPcsExportGlpiBusy(false)
    }
  }

  async function exportRequestsJson() {
    setReqExportJsonBusy(true)
    try {
      const r = await api.serviceRequests({ limit: 1000 })
      exportRequestsJsonFile(r.items, r.total)
      toast.ok(t('settingsGlpi.requestsExportJsonReady'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.requestsExportJsonFailed'))
    } finally {
      setReqExportJsonBusy(false)
    }
  }

  async function exportRequestsCsv() {
    setReqExportCsvBusy(true)
    try {
      const r = await api.serviceRequests({ limit: 1000 })
      exportRequestsCsvFile(r.items)
      toast.ok(t('settingsGlpi.requestsExportCsvReady'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.requestsExportCsvFailed'))
    } finally {
      setReqExportCsvBusy(false)
    }
  }

  async function exportRequestsGlpiCsv() {
    setReqExportGlpiBusy(true)
    try {
      await api.exportServiceRequestsGlpiCsv()
      toast.ok(t('settingsGlpi.requestsExportGlpiReady'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.requestsExportGlpiFailed'))
    } finally {
      setReqExportGlpiBusy(false)
    }
  }

  async function importRequestsJson(file: File) {
    setReqImportJsonBusy(true)
    try {
      const raw = await file.text()
      const parsed: unknown = JSON.parse(raw)
      const items = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : []
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error(t('settingsGlpi.invalidJsonFile'))
      }

      let ok = 0
      let fail = 0
      for (const item of items) {
        if (!isRecord(item)) {
          fail += 1
          continue
        }
        const title = String(item.title ?? '').trim()
        if (!title) {
          fail += 1
          continue
        }
        const assigneeIds = Array.isArray(item.assignee_ids)
          ? item.assignee_ids.map((value) => Number(value)).filter(Number.isFinite)
          : []
        try {
          await api.createServiceRequest({
            title,
            description: item.description != null ? String(item.description) : null,
            status: typeof item.status === 'string' ? item.status : undefined,
            priority: typeof item.priority === 'string' ? item.priority : undefined,
            computer_id: typeof item.computer_id === 'number' ? item.computer_id : null,
            assignee_ids: assigneeIds,
            opened_at: typeof item.opened_at === 'string' ? item.opened_at : null,
            planned_close_at: typeof item.planned_close_at === 'string' ? item.planned_close_at : null,
            closed_at: typeof item.closed_at === 'string' ? item.closed_at : null,
          })
          ok += 1
        } catch {
          fail += 1
        }
      }
      toast.ok(t('settingsGlpi.requestsImportJsonResult', { ok, fail }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.requestsImportJsonFailed'))
    } finally {
      setReqImportJsonBusy(false)
    }
  }

  return (
    <div>
      <PageHeader
        icon={<IconPcs className="h-6 w-6" />}
        title={t('titles.glpi')}
        subtitle={t('pages.glpiSubtitle')}
      />

      <div className="space-y-8">
        <div>
          <div className="mb-4 flex items-center gap-2">
            <IconPcs className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.parkTitle')}</h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{t('settingsGlpi.importTitle')}</h3>
              <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.pcsImportDescription')}
              </p>
              <input
                ref={glpiPcsImportRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setPcsImportBusy(true)
                  void api
                    .importGlpiPcsCsv(f)
                    .then((r) => {
                      toast.ok(
                        t('settingsGlpi.pcsImportSummary', {
                          created: r.created,
                          updated: r.updated,
                          skipped: r.skipped,
                          rows: r.rows_total,
                        }),
                      )
                    })
                    .catch((ex) => toast.error(ex instanceof Error ? ex.message : t('settingsGlpi.importFailed')))
                    .finally(() => {
                      setPcsImportBusy(false)
                      e.target.value = ''
                    })
                }}
              />
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={pcsImportBusy}
                onClick={() => glpiPcsImportRef.current?.click()}
              >
                {pcsImportBusy ? t('settingsGlpi.importBusy') : t('settingsGlpi.importFromGlpi')}
              </button>
            </section>

            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{t('settingsGlpi.exportTitle')}</h3>
              <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.pcsExportDescription')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={pcsExportBusy}
                  onClick={() => void exportParkCsv()}
                >
                  {pcsExportBusy ? t('settingsGlpi.exportBusy') : t('settingsGlpi.exportExcelCsv')}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={pcsExportGlpiBusy}
                  onClick={() => void exportParkGlpiCsv()}
                >
                  {pcsExportGlpiBusy ? t('settingsGlpi.exportBusy') : t('settingsGlpi.exportForGlpi')}
                </button>
              </div>
            </section>
          </div>
        </div>

        <div>
          <div className="mb-4 flex items-center gap-2">
            <IconTicket className="h-5 w-5 text-blue-600" />
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.requestsTitle')}</h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{t('settingsGlpi.importTitle')}</h3>
              <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.requestsImportDescription')}
              </p>
              <input
                ref={glpiRequestsImportRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setReqImportGlpiBusy(true)
                  void api
                    .importServiceRequestsGlpiCsv(f)
                    .then((r) => {
                      const errCount = Array.isArray(r.errors) ? r.errors.length : 0
                      toast.ok(
                        t('settingsGlpi.requestsImportGlpiSummary', {
                          created: r.created,
                          updated: r.updated,
                          skipped: r.skipped,
                          errors: errCount
                            ? t('settingsGlpi.requestsImportGlpiErrors', { count: errCount })
                            : '',
                        }),
                      )
                    })
                    .catch((ex) =>
                      toast.error(ex instanceof Error ? ex.message : t('settingsGlpi.requestsImportGlpiFailed')),
                    )
                    .finally(() => {
                      setReqImportGlpiBusy(false)
                      e.target.value = ''
                    })
                }}
              />
              <input
                ref={requestsJsonImportRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  void importRequestsJson(f)
                }}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-primary"
                  disabled={reqImportGlpiBusy}
                  onClick={() => glpiRequestsImportRef.current?.click()}
                >
                  {reqImportGlpiBusy ? t('settingsGlpi.importBusy') : t('settingsGlpi.importFromGlpi')}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqImportJsonBusy}
                  onClick={() => requestsJsonImportRef.current?.click()}
                >
                  {reqImportJsonBusy ? t('settingsGlpi.importBusy') : t('settingsGlpi.importFromJson')}
                </button>
              </div>
            </section>

            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">{t('settingsGlpi.exportTitle')}</h3>
              <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.requestsExportDescription')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqExportJsonBusy}
                  onClick={() => void exportRequestsJson()}
                >
                  {reqExportJsonBusy ? t('settingsGlpi.exportBusy') : 'JSON'}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqExportCsvBusy}
                  onClick={() => void exportRequestsCsv()}
                >
                  {reqExportCsvBusy ? t('settingsGlpi.exportBusy') : t('settingsGlpi.exportExcelCsv')}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqExportGlpiBusy}
                  onClick={() => void exportRequestsGlpiCsv()}
                >
                  {reqExportGlpiBusy ? t('settingsGlpi.exportBusy') : t('settingsGlpi.exportForGlpi')}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
