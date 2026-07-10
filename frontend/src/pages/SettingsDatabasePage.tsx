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
    return <p className="text-sm text-[var(--color-fg-subtle)]">Загрузка…</p>
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
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-fg-muted)]">
            Резервная копия PostgreSQL (формат <code className="text-xs">pg_dump -Fc</code>) и восстановление на другом
            сервере. Подходит для переноса CORAX между ПК и виртуалками (в т.ч. PG 16 → 18).
          </p>
        </div>
      </div>

      {toast ? (
        <div className="app-alert app-alert-success mb-4" role="status">
          {toast}
        </div>
      ) : null}

      {err ? <div className="app-alert app-alert-error mb-4">{err}</div> : null}

      {statusErr ? <div className="app-alert app-alert-warning mb-4">{statusErr}</div> : null}

      {status ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-subtle)]">База</div>
            <div className="mt-1 font-medium text-[var(--color-fg)]">
              {status.database ?? '—'} @ {status.host ?? '—'}:{status.port ?? '—'}
            </div>
          </div>
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-subtle)]">Записей</div>
            <div className="mt-1 text-[var(--color-fg-muted)]">
              ПК: {status.counts.computers} · заявки: {status.counts.service_requests} · пользователи:{' '}
              {status.counts.users}
            </div>
          </div>
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              pg_dump / pg_restore
            </div>
            <div
              className={`mt-1 font-medium ${
                toolsOk ? 'text-[var(--color-success-fg)]' : 'text-[var(--color-error-fg)]'
              }`}
            >
              {toolsOk ? 'Доступны' : 'Не найдены'}
            </div>
            {status.pg_bin_dir_configured ? (
              <div className="mt-1 break-all font-mono text-[11px] text-[var(--color-fg-subtle)]">
                {status.pg_bin_dir_configured}
              </div>
            ) : null}
            {!toolsOk ? (
              <div className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                Проверьте PG_BIN_DIR в backend/.env и перезапустите сервер.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!status?.single_database && status ? (
        <div className="app-alert app-alert-warning mb-6">
          В .env заданы разные URL для inventory / diagrams / warehouse. Дамп включает только основную базу из{' '}
          <code className="text-xs">DATABASE_URL</code>.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="app-card space-y-4 !p-6 sm:!p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            Экспорт (дамп)
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
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

        <section className="app-card space-y-4 !p-6 sm:!p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            Импорт (восстановление)
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
            <strong className="font-semibold text-[var(--color-primary)]">Перезапишет</strong> текущую базу PostgreSQL.
            Перед импортом сделайте дамп. Совместимо с дампами с другой версии PostgreSQL (16 → 18).
          </p>
          <label className="block text-sm text-[var(--color-fg-muted)]">
            Подтверждение: введите{' '}
            <code className="rounded bg-[var(--color-surface-muted)] px-1 text-xs text-[var(--color-fg)]">RESTORE</code>
            <input
              type="text"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="app-input mt-1.5"
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
            className="app-btn app-btn-danger"
            disabled={importBusy || !toolsOk || confirm.trim() !== 'RESTORE'}
            onClick={() => importRef.current?.click()}
          >
            {importBusy ? 'Восстановление…' : 'Выбрать .dump и восстановить'}
          </button>
        </section>
      </div>

      <div className="app-panel-sm mt-8 text-xs leading-relaxed text-[var(--color-fg-muted)]">
        <p>
          На Windows, если кнопки неактивны, добавьте в <code className="text-[var(--color-fg)]">backend/.env</code>:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-[11px] text-[var(--color-fg)]">
          PG_BIN_DIR=C:\Program Files\PostgreSQL\18\bin
        </pre>
        <p className="mt-2">
          На Linux обычно достаточно пакета <code className="text-[var(--color-fg)]">postgresql-client</code>; путь к
          bin при необходимости: <code className="text-[var(--color-fg)]">PG_BIN_DIR=/usr/lib/postgresql/16/bin</code>.
        </p>
        <p className="mt-2">
          Для импорта при активных подключениях может понадобиться{' '}
          <code className="text-[var(--color-fg)]">POSTGRES_ADMIN_PASSWORD</code> в .env.
        </p>
      </div>
    </div>
  )
}
