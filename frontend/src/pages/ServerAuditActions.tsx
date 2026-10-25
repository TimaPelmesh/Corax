import { useEffect, useState } from 'react'
import { api, type ServerAuditActionCatalog, type ServerAuditJob, type ServerAuditJobAction } from '../api'
import { useT } from '../i18n/LocaleContext'

const EMPTY_CATALOG: ServerAuditActionCatalog = {
  tests: ['nginx', 'sshd'],
  restart: ['nginx', 'sshd'],
  read: ['/etc/nginx/nginx.conf'],
  write_prefixes: ['/etc/nginx/conf.d/'],
}

function statusLabel(status: string, t: ReturnType<typeof useT>) {
  if (status === 'pending') return t('serverAudit.jobPending')
  if (status === 'leased') return t('serverAudit.jobLeased')
  if (status === 'done') return t('serverAudit.jobDone')
  if (status === 'expired') return t('serverAudit.jobExpired')
  return t('serverAudit.jobFailed')
}

function statusClass(status: string) {
  if (status === 'done') return 'text-emerald-700 dark:text-emerald-300'
  if (status === 'pending' || status === 'leased') return 'text-sky-700 dark:text-sky-300'
  return 'text-rose-700 dark:text-rose-300'
}

export function ServerAuditActions({
  jobs,
  busy,
  locale,
  onQueue,
}: {
  jobs: ServerAuditJob[]
  busy: boolean
  locale: string
  onQueue: (action: ServerAuditJobAction, target: string, body?: string) => Promise<void>
}) {
  const t = useT()
  const [catalog, setCatalog] = useState<ServerAuditActionCatalog>(EMPTY_CATALOG)
  const [unit, setUnit] = useState('nginx')
  const [readPath, setReadPath] = useState('/etc/nginx/nginx.conf')
  const [writePath, setWritePath] = useState('/etc/nginx/conf.d/corax.conf')
  const [fileBody, setFileBody] = useState('')

  useEffect(() => {
    let alive = true
    api
      .serverAuditActions()
      .then((rows) => {
        if (!alive) return
        setCatalog(rows)
        if (rows.restart[0]) setUnit(rows.restart.includes('nginx') ? 'nginx' : rows.restart[0])
        if (rows.read[0]) setReadPath(rows.read[0])
        if (rows.write_prefixes[0]) setWritePath(`${rows.write_prefixes[0]}corax.conf`)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const when = (iso: string | null) => {
    if (!iso) return ''
    try {
      return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return iso
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="text-sm font-semibold">{t('serverAudit.actions')}</h3>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.actionsLead')}</p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <ActionButton
            title={t('serverAudit.actNginxTest')}
            hint={t('serverAudit.actNginxTestHint')}
            disabled={busy}
            onClick={() => void onQueue('test', 'nginx')}
          />
          <ActionButton
            title={t('serverAudit.actSshdTest')}
            hint={t('serverAudit.actSshdTestHint')}
            disabled={busy}
            onClick={() => void onQueue('test', 'sshd')}
          />
          <ActionButton
            title={t('serverAudit.actNginxStatus')}
            hint={t('serverAudit.actStatusHint')}
            disabled={busy}
            onClick={() => void onQueue('status', 'nginx')}
          />
          <ActionButton
            title={t('serverAudit.actSshdStatus')}
            hint={t('serverAudit.actStatusHint')}
            disabled={busy}
            onClick={() => void onQueue('status', 'sshd')}
          />
          <ActionButton
            title={t('serverAudit.actNginxRestart')}
            hint={t('serverAudit.actRestartHint')}
            disabled={busy}
            tone="danger"
            onClick={() => void onQueue('restart', 'nginx')}
          />
          <ActionButton
            title={t('serverAudit.actSshdRestart')}
            hint={t('serverAudit.actRestartHint')}
            disabled={busy}
            tone="danger"
            onClick={() => void onQueue('restart', 'sshd')}
          />
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
            {t('serverAudit.restartUnit')}
            <span className="font-normal">{t('serverAudit.actRestartHint')}</span>
            <div className="flex flex-wrap gap-2">
              <select value={unit} onChange={(event) => setUnit(event.target.value)} className="app-input app-select min-w-[12rem] flex-1">
                {catalog.restart.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                className="app-btn app-btn-danger !min-h-0 !px-3 !py-2"
                onClick={() => void onQueue('restart', unit)}
              >
                {t('serverAudit.actRestartPick')}
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
            {t('serverAudit.pathLabel')}
            <span className="font-normal">{t('serverAudit.actReadHint')}</span>
            <div className="flex flex-wrap gap-2">
              <select value={readPath} onChange={(event) => setReadPath(event.target.value)} className="app-input app-select min-w-[12rem] flex-1">
                {catalog.read.map((path) => (
                  <option key={path} value={path}>
                    {path}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={busy}
                className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2"
                onClick={() => void onQueue('read', readPath)}
              >
                {t('serverAudit.actRead')}
              </button>
            </div>
          </label>
        </div>
        <label className="mt-3 flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
          {t('serverAudit.fileBody')}
          <span className="font-normal">{t('serverAudit.actWriteHint')}</span>
          <input value={writePath} onChange={(event) => setWritePath(event.target.value)} className="app-input font-mono" spellCheck={false} />
          <textarea
            value={fileBody}
            onChange={(event) => setFileBody(event.target.value)}
            rows={6}
            className="app-input min-h-[8rem] resize-y font-mono"
            spellCheck={false}
          />
          <span>
            <button
              type="button"
              disabled={busy || !fileBody.trim() || !writePath.trim()}
              className="app-btn app-btn-primary !min-h-0 !px-3 !py-2"
              onClick={() => void onQueue('write', writePath.trim(), fileBody)}
            >
              {t('serverAudit.actWrite')}
            </button>
          </span>
        </label>
      </section>
      <section className="overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]">
        <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">
          {t('serverAudit.jobHistory')}
        </h3>
        {jobs.length === 0 ? (
          <p className="px-4 py-4 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.actionsEmpty')}</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {jobs.map((job) => (
              <li key={job.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <span className={`text-xs font-semibold ${statusClass(job.status)}`}>{statusLabel(job.status, t)}</span>
                    <span className="ml-2 font-mono text-sm">{job.action}</span>
                    <span className="ml-2 break-all font-mono text-sm text-[var(--color-fg-subtle)]">{job.target}</span>
                  </div>
                  <div className="text-xs text-[var(--color-fg-subtle)]">
                    {when(job.finished_at || job.created_at)}
                    {job.exit_code != null ? ` · ${job.exit_code}` : ''}
                    {job.requested_by ? ` · ${t('serverAudit.jobWho')} ${job.requested_by}` : ''}
                  </div>
                </div>
                {job.output ? (
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg-muted)] p-3 font-mono text-xs">
                    {job.output}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ActionButton({
  title,
  hint,
  disabled,
  tone = 'secondary',
  onClick,
}: {
  title: string
  hint: string
  disabled: boolean
  tone?: 'secondary' | 'danger'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-md border px-3 py-3 text-left ${
        tone === 'danger'
          ? 'border-rose-500/40 hover:bg-rose-500/5'
          : 'border-[var(--color-border)] hover:bg-[var(--color-bg-muted)]'
      } disabled:opacity-50`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs font-normal text-[var(--color-fg-subtle)]">{hint}</span>
    </button>
  )
}
