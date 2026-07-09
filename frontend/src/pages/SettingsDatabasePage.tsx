import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type DatabaseBackupStatus } from '../api'
import { useAuth } from '../AuthContext'
import { IconDisk } from '../components/icons'

export function SettingsDatabasePage() {
  const { user, loading: authLoading } = useAuth()
  const importRef = useRef<HTMLInputElement | null>(null)
  const [status, setStatus] = useState<DatabaseBackupStatus | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    if (!user?.is_superuser) return
    void api
      .databaseBackupStatus()
      .then(setStatus)
      .catch((e) => setStatusErr(e instanceof Error ? e.message : 'Не удалось загрузить статус БД'))
  }, [user?.is_superuser])

  if (authLoading) {
    return <p className="text-sm text-slate-500">Загрузка…</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  function showToast(msg: string, ms = 7000) {
    setToast(msg)
    window.setTimeout(() => setToast(null), ms)
  }

  const toolsOk = Boolean(status?.pg_dump_available && status?.pg_restore_available)

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconDisk className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">База данных</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-600">
            Резервная копия PostgreSQL (формат <code className="text-xs">pg_dump -Fc</code>) и восстановление на другом
            сервере. Подходит для переноса CORAX между ПК и виртуалками (в т.ч. PG 16 → 18).
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

      {statusErr ? (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
          {statusErr}
        </div>
      ) : null}

      {status ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">База</div>
            <div className="mt-1 font-medium text-slate-900">
              {status.database ?? '—'} @ {status.host ?? '—'}:{status.port ?? '—'}
            </div>
          </div>
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Записей</div>
            <div className="mt-1 text-slate-800">
              ПК: {status.counts.computers} · заявки: {status.counts.service_requests} · пользователи:{' '}
              {status.counts.users}
            </div>
          </div>
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">pg_dump / pg_restore</div>
            <div className={`mt-1 font-medium ${toolsOk ? 'text-emerald-700' : 'text-red-700'}`}>
              {toolsOk ? 'Доступны' : 'Не найдены'}
            </div>
            {status.pg_bin_dir_configured ? (
              <div className="mt-1 break-all font-mono text-[11px] text-slate-500">{status.pg_bin_dir_configured}</div>
            ) : null}
            {!toolsOk ? (
              <div className="mt-1 text-xs text-slate-500">Проверьте PG_BIN_DIR в backend/.env и перезапустите сервер.</div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!status?.single_database && status ? (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          В .env заданы разные URL для inventory / diagrams / warehouse. Дамп включает только основную базу из{' '}
          <code className="text-xs">DATABASE_URL</code>.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Экспорт (дамп)</h2>
          <p className="text-sm leading-relaxed text-slate-600">
            Скачается файл <code className="text-xs">corax-имя_базы-дата.dump</code>. Сохраните его перед переносом на
            другой компьютер.
          </p>
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={exportBusy || !toolsOk}
            onClick={() => {
              setErr(null)
              setExportBusy(true)
              void api
                .exportDatabaseDump()
                .then(() => showToast('Дамп базы скачан'))
                .catch((e) => setErr(e instanceof Error ? e.message : 'Ошибка экспорта'))
                .finally(() => setExportBusy(false))
            }}
          >
            {exportBusy ? 'Создание дампа…' : 'Скачать дамп PostgreSQL'}
          </button>
        </section>

        <section className="app-card space-y-4 p-6 sm:p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400">Импорт (восстановление)</h2>
          <p className="text-sm leading-relaxed text-slate-600">
            <strong className="font-semibold text-red-700">Перезапишет</strong> текущую базу PostgreSQL. Перед импортом
            сделайте дамп. Совместимо с дампами с другой версии PostgreSQL (16 → 18).
          </p>
          <label className="block text-sm text-slate-700">
            Подтверждение: введите <code className="rounded bg-slate-100 px-1 text-xs">RESTORE</code>
            <input
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
              placeholder="RESTORE"
              autoComplete="off"
            />
          </label>
          <input
            ref={importRef}
            type="file"
            accept=".dump,.backup,application/octet-stream"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (!f) return
              setErr(null)
              setImportBusy(true)
              void api
                .importDatabaseDump(f, confirm)
                .then((r) => {
                  setConfirm('')
                  showToast(
                    `База «${r.database}» восстановлена (${Math.round(r.bytes / 1024)} КБ).${
                      r.restart_recommended ? ' Рекомендуется перезапустить CORAX.' : ''
                    }`,
                    10000,
                  )
                  return api.databaseBackupStatus().then(setStatus)
                })
                .catch((ex) => setErr(ex instanceof Error ? ex.message : 'Ошибка импорта'))
                .finally(() => {
                  setImportBusy(false)
                  e.target.value = ''
                })
            }}
          />
          <button
            type="button"
            className="app-btn app-btn-secondary border-red-200 text-red-800 hover:bg-blue-50"
            disabled={importBusy || !toolsOk || confirm.trim() !== 'RESTORE'}
            onClick={() => importRef.current?.click()}
          >
            {importBusy ? 'Восстановление…' : 'Выбрать .dump и восстановить'}
          </button>
        </section>
      </div>

      <div className="mt-8 rounded-xl border border-slate-200/90 bg-slate-50/80 px-4 py-3 text-xs leading-relaxed text-slate-600">
        <p>
          На Windows, если кнопки неактивны, добавьте в <code>backend/.env</code>:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-white p-3 text-[11px] text-slate-800">
          PG_BIN_DIR=C:\Program Files\PostgreSQL\18\bin
        </pre>
        <p className="mt-2">
          Для импорта при активных подключениях может понадобиться <code>POSTGRES_ADMIN_PASSWORD</code> в .env.
        </p>
      </div>
    </div>
  )
}
