import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { api, type DatabaseBackupStatus } from '../api'
import { useAuth } from '../AuthContext'
import { IconServer } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { Skeleton } from '../components/Skeleton'
import { StatusPill } from '../components/ui/StatusPill'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

export function SettingsDatabasePage() {
  const t = useT()
  const toast = useToast()
  const { user, loading: authLoading } = useAuth()
  const importRef = useRef<HTMLInputElement | null>(null)
  const [status, setStatus] = useState<DatabaseBackupStatus | null>(null)
  const [statusErr, setStatusErr] = useState<string | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [exportBusy, setExportBusy] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [confirm, setConfirm] = useState('')

  useEffect(() => {
    if (!user?.is_superuser) return
    setStatusLoading(true)
    void api
      .databaseBackupStatus()
      .then((s) => {
        setStatus(s)
        setStatusErr(null)
      })
      .catch((e) => setStatusErr(e instanceof Error ? e.message : t('settingsDatabase.loadStatusFailed')))
      .finally(() => setStatusLoading(false))
  }, [t, user?.is_superuser])

  if (authLoading) {
    return (
      <div className="settings-page" role="status" aria-busy="true">
        <Skeleton className="h-14 w-full max-w-md rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    )
  }

  if (!user?.is_superuser) {
    return <Navigate to="/" replace />
  }

  const toolsOk = Boolean(status?.pg_dump_available && status?.pg_restore_available)

  return (
    <div className="settings-page">
      <PageHeader
        icon={<IconServer className="h-7 w-7" />}
        title={t('titles.database')}
        subtitle={t('settingsPurpose.database')}
      />

      {statusErr ? <div className="app-alert app-alert-warning">{statusErr}</div> : null}

      {statusLoading && !status ? (
        <div className="grid gap-3 sm:grid-cols-3" role="status" aria-busy="true">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : null}

      {status ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="app-panel-sm">
            <div className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
              {t('settingsDatabase.databaseCard')}
            </div>
            <div className="mt-1 font-medium text-[var(--color-fg)]">
              {status.database ?? '—'} @ {status.host ?? '—'}:{status.port ?? '—'}
            </div>
          </div>
          <div className="app-panel-sm">
            <div className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
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
          <div className="app-panel-sm">
            <div className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">
              {t('settingsDatabase.pgToolsCard')}
            </div>
            <div className="mt-1.5">
              <StatusPill tone={toolsOk ? 'success' : 'warning'}>
                {toolsOk ? t('settingsDatabase.toolsAvailable') : t('settingsDatabase.toolsMissing')}
              </StatusPill>
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

      {status?.schedule ? (
        <section className="app-panel space-y-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('settingsDatabase.scheduleTitle')}</h2>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">{t('settingsDatabase.scheduleHint')}</p>
          <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={status.schedule.enabled}
              onChange={(e) => {
                const enabled = e.target.checked
                void api
                  .databaseBackupSchedule({ enabled })
                  .then((schedule) => setStatus({ ...status, schedule }))
                  .catch((e) => toast.error(e instanceof Error ? e.message : t('common.error')))
              }}
            />
            {t('settingsDatabase.scheduleOn')}
          </label>
          <label className="block text-sm text-[var(--color-fg)]">
            {t('settingsDatabase.intervalHours')}
            <input
              type="number"
              min={1}
              max={168}
              className="app-input mt-1 w-full max-w-[8rem]"
              value={status.schedule.interval_hours}
              onBlur={(e) => {
                const hours = Math.max(1, Math.min(168, Number.parseInt(e.target.value, 10) || 24))
                void api
                  .databaseBackupSchedule({ interval_hours: hours })
                  .then((schedule) => setStatus({ ...status, schedule }))
                  .catch((err) => toast.error(err instanceof Error ? err.message : t('common.error')))
              }}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="app-btn app-btn-secondary"
              disabled={exportBusy}
              onClick={() => {
                setExportBusy(true)
                void api
                  .databaseBackupCheck()
                  .then((schedule) => {
                    setStatus({ ...status, schedule })
                    toast.ok(schedule.last_message || t('settingsDatabase.lastCheck'))
                  })
                  .catch((e) => toast.error(e instanceof Error ? e.message : t('common.error')))
                  .finally(() => setExportBusy(false))
              }}
            >
              {exportBusy ? t('settingsDatabase.checkBusy') : t('settingsDatabase.checkButton')}
            </button>
            {status.schedule.last_message ? (
              <StatusPill tone={status.schedule.last_ok ? 'success' : status.schedule.last_ok === false ? 'error' : 'neutral'}>
                {status.schedule.last_message}
              </StatusPill>
            ) : null}
          </div>
        </section>
      ) : null}

      {!status?.single_database && status ? (
        <div className="app-alert app-alert-warning">
          {t('settingsDatabase.multiDbWarning')}{' '}
          <code className="text-xs">DATABASE_URL</code>.
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="app-panel space-y-4">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            {t('settingsDatabase.exportTitle')}
          </h2>
          <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {t('settingsDatabase.exportDescription')}
          </p>
          <button
            type="button"
            className="app-btn app-btn-primary w-full sm:w-auto"
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

        <section className="app-panel space-y-4">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
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
            className="app-btn app-btn-danger w-full sm:w-auto"
            disabled={importBusy || !toolsOk || confirm.trim() !== 'RESTORE'}
            onClick={() => importRef.current?.click()}
          >
            {importBusy ? t('settingsDatabase.importBusy') : t('settingsDatabase.importButton')}
          </button>
        </section>
      </div>

      <div className="app-panel text-xs leading-relaxed text-[var(--color-fg-muted)]">
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
