import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type ServiceRequestImportStatus, type ServiceRequestRow, type WarehouseRoom } from '../api'
import { useAuth } from '../AuthContext'
import { IconPcs, IconTicket, IconWarehouse } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

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
  const warehouseImportRef = useRef<HTMLInputElement | null>(null)
  const [pcsImportBusy, setPcsImportBusy] = useState(false)
  const [pcsExportBusy, setPcsExportBusy] = useState(false)
  const [pcsExportGlpiBusy, setPcsExportGlpiBusy] = useState(false)
  const [reqImportGlpiBusy, setReqImportGlpiBusy] = useState(false)
  const [reqImportJsonBusy, setReqImportJsonBusy] = useState(false)
  const [reqExportJsonBusy, setReqExportJsonBusy] = useState(false)
  const [reqExportCsvBusy, setReqExportCsvBusy] = useState(false)
  const [reqExportGlpiBusy, setReqExportGlpiBusy] = useState(false)
  const [warehouseImportBusy, setWarehouseImportBusy] = useState(false)
  const [warehouseExportBusy, setWarehouseExportBusy] = useState(false)
  const [warehouseRooms, setWarehouseRooms] = useState<WarehouseRoom[]>([])
  const [warehouseImportRoomId, setWarehouseImportRoomId] = useState<number | null>(null)
  const [requestImportJob, setRequestImportJob] = useState<ServiceRequestImportStatus | null>(null)
  const requestImportWasRunning = useRef(false)

  useEffect(() => {
    if (!user?.is_superuser) return
    void api
      .warehouseRooms()
      .then((rows) => {
        setWarehouseRooms(rows)
        setWarehouseImportRoomId((prev) => {
          if (prev != null && rows.some((r) => r.id === prev)) return prev
          return rows.length ? rows[rows.length - 1].id : null
        })
      })
      .catch(() => {
        setWarehouseRooms([])
      })
  }, [user?.is_superuser])

  useEffect(() => {
    if (!user?.is_superuser) return
    let cancelled = false
    const tick = async () => {
      try {
        const status = await api.serviceRequestImportStatus()
        if (cancelled) return
        const wasRunning = requestImportWasRunning.current
        setRequestImportJob(status)
        if (status.running) {
          requestImportWasRunning.current = true
        } else if (wasRunning) {
          requestImportWasRunning.current = false
          if (status.phase === 'error') {
            toast.error(status.error || status.message || t('settingsGlpi.requestsImportFailed'))
          } else {
            toast.ok(
              t('settingsGlpi.requestsImportDone', {
                created: status.created,
                updated: status.updated,
                skipped: status.skipped,
                errors: status.errors_count,
              }),
            )
          }
        }
      } catch {
        /* A transient status failure must not interrupt the background import. */
      }
    }
    void tick()
    const interval = window.setInterval(() => void tick(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [t, toast, user?.is_superuser])

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

  async function exportWarehouse() {
    setWarehouseExportBusy(true)
    try {
      await api.exportWarehouseCsv()
      toast.ok(t('settingsGlpi.warehouseExportReady'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.csvExportFailed'))
    } finally {
      setWarehouseExportBusy(false)
    }
  }

  async function importWarehouse(file: File) {
    setWarehouseImportBusy(true)
    try {
      const r = await api.importWarehouseCsv(file, warehouseImportRoomId)
      toast.ok(t('settingsGlpi.warehouseImportOk', { created: r.created, updated: r.updated }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('warehouse.csvImportFailed'))
    } finally {
      setWarehouseImportBusy(false)
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

  async function startRequestImport(file: File, kind: 'glpi_csv' | 'corax_json') {
    const setBusy = kind === 'glpi_csv' ? setReqImportGlpiBusy : setReqImportJsonBusy
    setBusy(true)
    try {
      const status =
        kind === 'glpi_csv'
          ? await api.importServiceRequestsGlpiCsv(file)
          : await api.importServiceRequestsJson(file)
      setRequestImportJob(status)
      requestImportWasRunning.current = status.running
      toast.info(t('settingsGlpi.requestsImportStarted'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('settingsGlpi.requestsImportFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <PageHeader
        icon={<IconPcs className="h-6 w-6" />}
        title={t('titles.glpi')}
        subtitle={t('pages.glpiSubtitle')}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
              <IconPcs className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.parkTitle')}</h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.pcsImportDescription')}
              </p>
            </div>
          </div>

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

          <div className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {t('settingsGlpi.importTitle')}
              </p>
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={pcsImportBusy}
                onClick={() => glpiPcsImportRef.current?.click()}
              >
                {pcsImportBusy ? t('settingsGlpi.importBusy') : t('settingsGlpi.importFromGlpi')}
              </button>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {t('settingsGlpi.exportTitle')}
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
            </div>
          </div>
        </section>

        <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
              <IconTicket className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.requestsTitle')}</h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.requestsImportDescription')}
              </p>
            </div>
          </div>

          <input
            ref={glpiRequestsImportRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              void startRequestImport(f, 'glpi_csv')
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
              void startRequestImport(f, 'corax_json')
            }}
          />

          {requestImportJob?.running ? (
            <div className="rounded-xl border border-[var(--color-primary)]/30 bg-[var(--color-bg-muted)] px-4 py-3">
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 inline-block h-7 w-7 shrink-0 animate-spin rounded-full border-[3px] border-[var(--color-primary)]/25 border-t-[var(--color-primary)]"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-semibold text-[var(--color-fg)]">
                      {t('settingsGlpi.requestsImportProgressTitle')}
                    </p>
                    <span className="text-xs font-medium text-[var(--color-fg-subtle)]">
                      {requestImportJob.progress}%
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-[var(--color-fg-subtle)]">
                    {requestImportJob.message || t('settingsGlpi.requestsImportWorking')}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                    {t('settingsGlpi.requestsImportCanLeave')}
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface)]">
                    <div
                      className="h-full rounded-full bg-[var(--color-primary)] transition-[width] duration-500 ease-out"
                      style={{ width: `${Math.max(3, requestImportJob.progress)}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          <div className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {t('settingsGlpi.importTitle')}
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-primary"
                  disabled={reqImportGlpiBusy || requestImportJob?.running}
                  onClick={() => glpiRequestsImportRef.current?.click()}
                >
                  {reqImportGlpiBusy || requestImportJob?.running
                    ? t('settingsGlpi.importBusy')
                    : t('settingsGlpi.importFromGlpi')}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqImportJsonBusy || requestImportJob?.running}
                  onClick={() => requestsJsonImportRef.current?.click()}
                >
                  {reqImportJsonBusy || requestImportJob?.running
                    ? t('settingsGlpi.importBusy')
                    : t('settingsGlpi.importFromJson')}
                </button>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {t('settingsGlpi.exportTitle')}
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
            </div>
          </div>
        </section>

        <section className="space-y-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 xl:col-span-2">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-primary-muted)] text-[var(--color-primary)]">
              <IconWarehouse className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsGlpi.warehouseTitle')}</h2>
              <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">
                {t('settingsGlpi.warehouseDescription')}
              </p>
            </div>
          </div>

          <input
            ref={warehouseImportRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void importWarehouse(f)
            }}
          />

          <div className="flex flex-col gap-4 border-t border-[var(--color-border)] pt-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="min-w-0 flex-1 space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {t('settingsGlpi.importTitle')}
              </p>
              <label className="block max-w-md">
                <span className="app-label">{t('settingsGlpi.warehouseImportRoom')}</span>
                <select
                  className="app-input mt-1 w-full"
                  value={warehouseImportRoomId ?? ''}
                  onChange={(e) => {
                    const v = e.target.value
                    setWarehouseImportRoomId(v ? Number(v) : null)
                  }}
                >
                  <option value="">{t('settingsGlpi.warehouseImportRoomAuto')}</option>
                  {warehouseRooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.title}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="app-btn app-btn-primary"
                disabled={warehouseImportBusy}
                onClick={() => warehouseImportRef.current?.click()}
              >
                {warehouseImportBusy ? t('settingsGlpi.importBusy') : t('settingsGlpi.warehouseImport')}
              </button>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {t('settingsGlpi.exportTitle')}
              </p>
              <button
                type="button"
                className="app-btn app-btn-secondary"
                disabled={warehouseExportBusy}
                onClick={() => void exportWarehouse()}
              >
                {warehouseExportBusy ? t('settingsGlpi.exportBusy') : t('settingsGlpi.warehouseExport')}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
