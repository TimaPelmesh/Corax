import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type DatabaseBackupStatus } from '../api'
import { useAuth } from '../AuthContext'
import { IconDisk } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function SettingsDatabasePage() {
  const t = useT()
  const toast = useToast()
  const { user, loading: authLoading } = useAuth()
  const importRef = useRef<HTMLInputElement | null>(null)
  const [status, setStatus] = useState<DatabaseBackupStatus | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    if (!user?.is_superuser) return
    void api
      .databaseBackupStatus()
      .then(setStatus)
      .catch((e) => setStatusErr(e instanceof Error ? e.message : t('settingsDatabase.loadStatusFailed')))
  }, [t, user?.is_superuser])

  if (authLoading) {
    return <p className="text-sm text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  const toolsOk = Boolean(status?.pg_dump_available && status?.pg_restore_available)

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:mb-8 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconDisk className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.database')}</h1>
          <p className="mt-1 max-w-3xl text-sm text-[var(--color-fg-muted)]">
            {t('pages.databaseSubtitle')}
          </p>
        </div>
      </div>

      {statusErr ? <div className="app-alert app-alert-warning mb-4">{statusErr}</div> : null}

      {status ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('settingsDatabase.databaseCard')}
            </div>
            <div className="mt-1 font-medium text-[var(--color-fg)]">
              {status.database ?? '—'} @ {status.host ?? '—'}:{status.port ?? '—'}
            </div>
          </div>
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('settingsDatabase.recordsCard')}
            </div>
            <div className="mt-1 text-[var(--color-fg-muted)]">
              {t('settingsDatabase.recordsSummary', {
                computers: status.counts.computers,
                requests: status.counts.service_requests,
                users: status.counts.users,
              })}
            </div>
          </div>
          <div className="app-card px-4 py-3 text-sm">
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('settingsDatabase.pgToolsCard')}
            </div>
            <div
              className={`mt-1 font-medium ${
                toolsOk ? 'text-[var(--color-success-fg)]' : 'text-[var(--color-error-fg)]'
              }`}
            >
              {toolsOk ? t('settingsDatabase.toolsAvailable') : t('settingsDatabase.toolsMissing')}
            </div>
            {status.pg_bin_dir_configured ? (
              <div className="mt-1 break-all font-mono text-[11px] text-[var(--color-fg-subtle)]">
                {status.pg_bin_dir_configured}
              </div>
            ) : null}
            {!toolsOk ? (
              <div className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                {t('settingsDatabase.toolsHint')}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {!status?.single_database && status ? (
        <div className="app-alert app-alert-warning mb-6">
          {t('settingsDatabase.multiDbWarning')}{' '}
          <code className="text-xs">DATABASE_URL</code>.
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="app-card space-y-4 !p-6 sm:!p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            {t('settingsDatabase.exportTitle')}
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {t('settingsDatabase.exportDescription')}
          </p>
          <button
            type="button"
            className="app-btn app-btn-primary"
            disabled={exportBusy || !toolsOk}
            onClick={() => {
              setExportBusy(true)
              void api
                .exportDatabaseDump()
                .then(() => toast.ok(t('settingsDatabase.exportSuccess')))
                .catch((e) => toast.error(e instanceof Error ? e.message : t('settingsDatabase.exportFailed')))
                .finally(() => setExportBusy(false))
            }}
          >
            {exportBusy ? t('settingsDatabase.exportBusy') : t('settingsDatabase.exportButton')}
          </button>
        </section>

        <section className="app-card space-y-4 !p-6 sm:!p-7">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            {t('settingsDatabase.importTitle')}
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {t('settingsDatabase.importDescription')}
          </p>
          <label className="block text-sm text-[var(--color-fg-muted)]">
            {t('settingsDatabase.confirmLabel', { word: 'RESTORE' })}{' '}
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
              setImportBusy(true)
              void api
                .importDatabaseDump(f, confirm)
                .then((r) => {
                  setConfirm('')
                  if (r.warnings && r.log_tail) {
                    toast.error(
                      t('settingsDatabase.importWarnings', {
                        database: r.database,
                        detail: r.log_tail.slice(0, 400),
                      }),
                    )
                  } else {
                    toast.ok(
                      t('settingsDatabase.importSuccess', {
                        database: r.database,
                        kb: Math.round(r.bytes / 1024),
                        restart: r.restart_recommended
                          ? t('settingsDatabase.restartRecommended')
                          : '',
                      }),
                    )
                  }
                  return api.databaseBackupStatus().then(setStatus)
                })
                .catch((ex) => toast.error(ex instanceof Error ? ex.message : t('settingsDatabase.importFailed')))
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
            {importBusy ? t('settingsDatabase.importBusy') : t('settingsDatabase.importButton')}
          </button>
        </section>
      </div>

      <div className="app-panel-sm mt-8 text-xs leading-relaxed text-[var(--color-fg-muted)]">
        <p>
          {t('settingsDatabase.windowsHintIntro')}{' '}
          <code className="text-[var(--color-fg)]">backend/.env</code>:
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 font-mono text-[11px] text-[var(--color-fg)]">
          PG_BIN_DIR=C:\Program Files\PostgreSQL\18\bin
        </pre>
        <p className="mt-2">
          {t('settingsDatabase.linuxHint')}
        </p>
        <p className="mt-2">
          {t('settingsDatabase.adminPasswordHint')}
        </p>
      </div>
    </div>
  )
}
