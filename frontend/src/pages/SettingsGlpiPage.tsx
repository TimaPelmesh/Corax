import { useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type ServiceRequestRow } from '../api'
import { useAuth } from '../AuthContext'
import { IconPcs, IconTicket } from '../components/icons'

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
  const { user, loading: authLoading } = useAuth()
  const glpiPcsImportRef = useRef<HTMLInputElement | null>(null)
  const glpiRequestsImportRef = useRef<HTMLInputElement | null>(null)
  const requestsJsonImportRef = useRef<HTMLInputElement | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [pcsImportBusy, setPcsImportBusy] = useState(false)
  const [pcsExportBusy, setPcsExportBusy] = useState(false)
  const [pcsExportGlpiBusy, setPcsExportGlpiBusy] = useState(false)
  const [reqImportGlpiBusy, setReqImportGlpiBusy] = useState(false)
  const [reqImportJsonBusy, setReqImportJsonBusy] = useState(false)
  const [reqExportJsonBusy, setReqExportJsonBusy] = useState(false)
  const [reqExportCsvBusy, setReqExportCsvBusy] = useState(false)
  const [reqExportGlpiBusy, setReqExportGlpiBusy] = useState(false)

  if (authLoading) {
    return <p className="text-sm text-slate-500">Загрузка…</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  function showToast(msg: string, ms = 5000) {
    setToast(msg)
    window.setTimeout(() => setToast(null), ms)
  }

  async function exportParkCsv() {
    setErr(null)
    setPcsExportBusy(true)
    try {
      await api.exportComputersCsv()
      showToast('Экспорт парка готов (UTF-8, разделитель «;» для Excel)')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка экспорта CSV')
    } finally {
      setPcsExportBusy(false)
    }
  }

  async function exportParkGlpiCsv() {
    setErr(null)
    setPcsExportGlpiBusy(true)
    try {
      await api.exportGlpiPcsCsv()
      showToast('Экспорт парка для GLPI готов (glpi_pcs_export.csv)')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка экспорта GLPI CSV')
    } finally {
      setPcsExportGlpiBusy(false)
    }
  }

  async function exportRequestsJson() {
    setErr(null)
    setReqExportJsonBusy(true)
    try {
      const r = await api.serviceRequests({ limit: 1000 })
      exportRequestsJsonFile(r.items, r.total)
      showToast('Экспорт заявок (JSON) готов')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка экспорта JSON')
    } finally {
      setReqExportJsonBusy(false)
    }
  }

  async function exportRequestsCsv() {
    setErr(null)
    setReqExportCsvBusy(true)
    try {
      const r = await api.serviceRequests({ limit: 1000 })
      exportRequestsCsvFile(r.items)
      showToast('Экспорт заявок (CSV) готов (UTF-8, «;» для Excel)')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка экспорта CSV')
    } finally {
      setReqExportCsvBusy(false)
    }
  }

  async function exportRequestsGlpiCsv() {
    setErr(null)
    setReqExportGlpiBusy(true)
    try {
      await api.exportServiceRequestsGlpiCsv()
      showToast('Экспорт заявок для GLPI готов (glpi.csv)')
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка экспорта GLPI CSV')
    } finally {
      setReqExportGlpiBusy(false)
    }
  }

  async function importRequestsJson(file: File) {
    setErr(null)
    setReqImportJsonBusy(true)
    try {
      const raw = await file.text()
      const parsed: unknown = JSON.parse(raw)
      const items = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.items) ? parsed.items : []
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('Файл не похож на экспорт заявок (нет items[])')
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
      showToast(`Импорт заявок (JSON): создано ${ok}, пропущено/ошибки ${fail}`, 7000)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Ошибка импорта JSON')
    } finally {
      setReqImportJsonBusy(false)
    }
  }

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconPcs className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">GLPI</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Импорт и экспорт данных CORAX в форматах GLPI и резервных копий (JSON, CSV). Операции редкие — вынесены из
            рабочих вкладок в настройки.
          </p>
        </div>
      </div>

      {toast ? (
        <div
          className="mb-4 rounded-xl border border-zinc-200/90 bg-zinc-50 px-4 py-3 text-sm font-medium text-neutral-950 shadow-sm"
          role="status"
        >
          {toast}
        </div>
      ) : null}

      {err ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">{err}</div>
      ) : null}

      <div className="space-y-8">
        <div>
          <div className="mb-4 flex items-center gap-2">
            <IconPcs className="h-5 w-5 text-red-600" />
            <h2 className="text-sm font-semibold text-slate-900">Парк ПК</h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Импорт</h3>
              <p className="text-sm leading-relaxed text-slate-600">
                CSV-экспорт компьютеров из GLPI. Записи создаются и обновляются по имени хоста; дубликаты и пустые строки
                пропускаются.
              </p>
              <input
                ref={glpiPcsImportRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setErr(null)
                  setPcsImportBusy(true)
                  void api
                    .importGlpiPcsCsv(f)
                    .then((r) => {
                      showToast(
                        `Парк ПК: создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped}. (${r.rows_total} строк)`,
                        7000,
                      )
                    })
                    .catch((ex) => setErr(ex instanceof Error ? ex.message : 'Ошибка импорта'))
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
                {pcsImportBusy ? 'Импорт…' : 'Импорт из GLPI'}
              </button>
            </section>

            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Экспорт</h3>
              <p className="text-sm leading-relaxed text-slate-600">
                Выгрузка парка из CORAX: универсальный CSV для Excel или формат GLPI для сверки и обратной загрузки.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={pcsExportBusy}
                  onClick={() => void exportParkCsv()}
                >
                  {pcsExportBusy ? 'Экспорт…' : 'CSV для Excel'}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={pcsExportGlpiBusy}
                  onClick={() => void exportParkGlpiCsv()}
                >
                  {pcsExportGlpiBusy ? 'Экспорт…' : 'CSV для GLPI'}
                </button>
              </div>
            </section>
          </div>
        </div>

        <div>
          <div className="mb-4 flex items-center gap-2">
            <IconTicket className="h-5 w-5 text-red-600" />
            <h2 className="text-sm font-semibold text-slate-900">Заявки</h2>
          </div>
          <div className="grid gap-6 lg:grid-cols-2">
            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Импорт</h3>
              <p className="text-sm leading-relaxed text-slate-600">
                Загрузка тикетов из GLPI (glpi.csv) или восстановление из JSON-резервной копии CORAX.
              </p>
              <input
                ref={glpiRequestsImportRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  setErr(null)
                  setReqImportGlpiBusy(true)
                  void api
                    .importServiceRequestsGlpiCsv(f)
                    .then((r) => {
                      const errCount = Array.isArray(r.errors) ? r.errors.length : 0
                      showToast(
                        `GLPI: создано ${r.created}, обновлено ${r.updated}, пропущено ${r.skipped}${errCount ? `, ошибки ${errCount}` : ''}`,
                        7000,
                      )
                    })
                    .catch((ex) => setErr(ex instanceof Error ? ex.message : 'Ошибка импорта GLPI'))
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
                  {reqImportGlpiBusy ? 'Импорт…' : 'Импорт из GLPI'}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqImportJsonBusy}
                  onClick={() => requestsJsonImportRef.current?.click()}
                >
                  {reqImportJsonBusy ? 'Импорт…' : 'Импорт из JSON'}
                </button>
              </div>
            </section>

            <section className="app-card space-y-4 p-6 sm:p-7">
              <h3 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Экспорт</h3>
              <p className="text-sm leading-relaxed text-slate-600">
                До 1000 последних заявок. JSON — полная копия для переноса; CSV — для Excel; GLPI CSV — для миграции в
                GLPI.
              </p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqExportJsonBusy}
                  onClick={() => void exportRequestsJson()}
                >
                  {reqExportJsonBusy ? 'Экспорт…' : 'JSON'}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqExportCsvBusy}
                  onClick={() => void exportRequestsCsv()}
                >
                  {reqExportCsvBusy ? 'Экспорт…' : 'CSV для Excel'}
                </button>
                <button
                  type="button"
                  className="app-btn app-btn-secondary"
                  disabled={reqExportGlpiBusy}
                  onClick={() => void exportRequestsGlpiCsv()}
                >
                  {reqExportGlpiBusy ? 'Экспорт…' : 'CSV для GLPI'}
                </button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
