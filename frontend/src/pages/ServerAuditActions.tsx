import { useEffect, useState } from 'react'
import { api, type ServerAuditActionCatalog, type ServerAuditJob, type ServerAuditJobAction } from '../api'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { useT } from '../i18n/LocaleContext'

const EMPTY_CATALOG: ServerAuditActionCatalog = {
  tests: ['nginx', 'sshd'],
  restart: ['nginx', 'sshd'],
  read: ['/etc/nginx/nginx.conf'],
  write_prefixes: ['/etc/nginx/conf.d/'],
}

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$/
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/

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

function actionLabel(action: string, t: ReturnType<typeof useT>) {
  if (action === 'test') return t('serverAudit.actKindTest')
  if (action === 'status') return t('serverAudit.actKindStatus')
  if (action === 'restart') return t('serverAudit.actKindRestart')
  if (action === 'read') return t('serverAudit.actKindRead')
  if (action === 'write') return t('serverAudit.actKindWrite')
  if (action === 'units') return t('serverAudit.actKindUnits')
  if (action === 'show') return t('serverAudit.actKindShow')
  return action
}

type UnitRow = { name: string; active: string; sub: string; description: string }

function parseUnits(output: string) {
  const rows: UnitRow[] = []
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('UNIT') || trimmed.startsWith('Legend')) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 4 || !parts[0].endsWith('.service')) continue
    rows.push({
      name: parts[0].slice(0, -'.service'.length),
      active: parts[2],
      sub: parts[3],
      description: parts.slice(4).join(' '),
    })
  }
  return rows
}

export function ServerAuditActions({
  jobs,
  busy,
  locale,
  view,
  onQueue,
}: {
  jobs: ServerAuditJob[]
  busy: boolean
  locale: string
  view: 'ops' | 'files'
  onQueue: (action: ServerAuditJobAction, target: string, body?: string) => Promise<void>
}) {
  const t = useT()
  const confirm = useConfirmDialog()
  const [catalog, setCatalog] = useState<ServerAuditActionCatalog>(EMPTY_CATALOG)
  const [picked, setPicked] = useState('')
  const [statusUnit, setStatusUnit] = useState('nginx')
  const [restartUnit, setRestartUnit] = useState('nginx')
  const [extraUnit, setExtraUnit] = useState('')
  const [readPath, setReadPath] = useState('/etc/nginx/nginx.conf')
  const [writePrefix, setWritePrefix] = useState('/etc/nginx/conf.d/')
  const [writeName, setWriteName] = useState('corax.conf')
  const [fileBody, setFileBody] = useState('')
  const [openId, setOpenId] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    api
      .serverAuditActions()
      .then((rows) => {
        if (!alive) return
        setCatalog(rows)
        if (rows.restart[0]) {
          const picked = rows.restart.includes('nginx') ? 'nginx' : rows.restart[0]
          setStatusUnit(picked)
          setRestartUnit(picked)
        }
        if (rows.read[0]) setReadPath(rows.read[0])
        if (rows.write_prefixes[0]) setWritePrefix(rows.write_prefixes[0])
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

  const statusTarget = extraUnit.trim() || statusUnit
  const statusOk = UNIT_RE.test(statusTarget)
  const nameOk = FILE_RE.test(writeName.trim())
  const writePath = `${writePrefix}${writeName.trim()}`

  const unitsJob = jobs.find((job) => job.action === 'units' && job.status === 'done' && job.output)
  const units = parseUnits(unitsJob?.output || '')
  const shown = jobs.find((job) => job.action === 'show' && job.target === picked && job.output)

  async function restartPicked(unit = picked) {
    if (!unit || !UNIT_RE.test(unit)) return
    const ok = await confirm.ask({
      title: t('serverAudit.playStepRestart'),
      body: t('serverAudit.playRestartAsk', { unit }),
      confirmLabel: t('serverAudit.playStepRestart'),
      tone: 'danger',
    })
    if (!ok) return
    await onQueue('restart', unit)
  }

  return (
    <div className="flex flex-col gap-4">
      {confirm.dialog}
      {view === 'ops' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 p-4">
            <div className="text-sm font-semibold text-[var(--color-fg)]">{t('serverAudit.playTitle')}</div>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-subtle)]">{t('serverAudit.playLead')}</p>
            <div className="mt-4 grid items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
              {(
                [
                  { n: '1', title: t('serverAudit.playStepUnits'), run: () => void onQueue('units', 'service'), disabled: busy },
                  { n: '2', title: t('serverAudit.playStepShow'), run: () => void onQueue('show', picked), disabled: busy || !picked },
                  { n: '3', title: t('serverAudit.playStepRestart'), run: () => void restartPicked(picked), disabled: busy || !picked },
                ] as const
              ).map((step, index) => (
                <div key={step.n} className="contents">
                  <div className="flex flex-col justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">{step.n}</div>
                      <div className="mt-1 text-sm font-medium text-[var(--color-fg)]">{step.title}</div>
                    </div>
                    <button type="button" className="app-btn app-btn-secondary mt-3 !min-h-0 !px-3 !py-2" disabled={step.disabled} onClick={step.run}>
                      {t('serverAudit.playRun')}
                    </button>
                  </div>
                  {index < 2 ? <div className="hidden items-center justify-center text-[var(--color-fg-subtle)] md:flex">→</div> : null}
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">{picked ? picked : t('serverAudit.playPick')}</p>
            {units.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.playEmpty')}</p>
            ) : (
              <div className="mt-3 grid max-h-64 gap-1 overflow-auto sm:grid-cols-2">
                {units.map((unit) => {
                  const on = unit.active === 'active'
                  const selected = picked === unit.name
                  return (
                    <button
                      key={unit.name}
                      type="button"
                      onClick={() => setPicked(unit.name)}
                      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-left ${selected ? 'border-[var(--color-primary)] bg-[var(--color-surface)]' : 'border-transparent hover:bg-[var(--color-surface)]'}`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-[var(--color-fg-subtle)]'}`} />
                      <span className="min-w-0">
                        <span className="block truncate font-mono text-xs text-[var(--color-fg)]">{unit.name}</span>
                        <span className="block truncate text-[11px] text-[var(--color-fg-subtle)]">{unit.active} · {unit.sub}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
            {shown?.output ? (
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-[11px] text-[var(--color-fg)]">{shown.output}</pre>
            ) : null}
          </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('serverAudit.actGroupCheck')}
            </div>
            <button type="button" disabled={busy} className="app-btn app-btn-secondary !min-h-0 !justify-start !px-3 !py-2" onClick={() => void onQueue('test', 'nginx')}>
              {t('serverAudit.actNginxTest')}
            </button>
            <button type="button" disabled={busy} className="app-btn app-btn-secondary !min-h-0 !justify-start !px-3 !py-2" onClick={() => void onQueue('test', 'sshd')}>
              {t('serverAudit.actSshdTest')}
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('serverAudit.actGroupStatus')}
            </div>
            <select value={statusUnit} onChange={(event) => setStatusUnit(event.target.value)} className="app-input app-select">
              {catalog.restart.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <label className="flex flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
              {t('serverAudit.actUnitExtra')}
              <input
                value={extraUnit}
                onChange={(event) => setExtraUnit(event.target.value)}
                placeholder="cron"
                className="app-input font-mono"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <button
              type="button"
              disabled={busy || !statusOk}
              className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2"
              onClick={() => void onQueue('status', statusTarget)}
            >
              {t('serverAudit.actStatusRun')}
            </button>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('serverAudit.actGroupRestart')}
            </div>
            <select value={restartUnit} onChange={(event) => setRestartUnit(event.target.value)} className="app-input app-select">
              {catalog.restart.map((name) => (
                <option key={`restart-${name}`} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              className="app-btn app-btn-danger !min-h-0 !px-3 !py-2"
              onClick={() => void restartPicked(restartUnit)}
            >
              {t('serverAudit.actRestartPick')}
            </button>
          </div>
        </div>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('serverAudit.actRead')}
            </div>
            <select value={readPath} onChange={(event) => setReadPath(event.target.value)} className="app-input app-select font-mono">
              {catalog.read.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <span>
              <button type="button" disabled={busy} className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" onClick={() => void onQueue('read', readPath)}>
                {t('serverAudit.actRead')}
              </button>
            </span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
              {t('serverAudit.actWrite')}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <select value={writePrefix} onChange={(event) => setWritePrefix(event.target.value)} className="app-input app-select min-w-0 flex-1 font-mono">
                {catalog.write_prefixes.map((prefix) => (
                  <option key={prefix} value={prefix}>
                    {prefix}
                  </option>
                ))}
              </select>
              <label className="flex min-w-[9rem] flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                {t('serverAudit.actWriteName')}
                <input
                  value={writeName}
                  onChange={(event) => setWriteName(event.target.value)}
                  className="app-input font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
            </div>
            <textarea
              value={fileBody}
              onChange={(event) => setFileBody(event.target.value)}
              rows={6}
              className="app-input min-h-[8rem] resize-y font-mono"
              spellCheck={false}
              aria-label={t('serverAudit.fileBody')}
            />
            <span>
              <button
                type="button"
                disabled={busy || !fileBody.trim() || !nameOk}
                className="app-btn app-btn-primary !min-h-0 !px-3 !py-2"
                onClick={() => void onQueue('write', writePath, fileBody)}
              >
                {t('serverAudit.actWrite')}
              </button>
            </span>
          </div>
        </div>
      )}

      <section className="app-card app-table-shell overflow-hidden p-0">
        <h3 className="border-b border-[var(--color-border)] px-4 py-3 text-sm font-semibold">{t('serverAudit.jobHistory')}</h3>
        {jobs.length === 0 ? (
          <p className="px-4 py-4 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.actionsEmpty')}</p>
        ) : (
          <div className="overflow-auto">
            <table className="app-table min-w-[40rem] w-full text-left">
              <thead className="app-table-head">
                <tr>
                  <th className="px-3 py-2">{t('serverAudit.actGroupStatus')}</th>
                  <th className="px-3 py-2">{t('serverAudit.actions')}</th>
                  <th className="px-3 py-2">{t('serverAudit.pathLabel')}</th>
                  <th className="px-3 py-2">{t('serverAudit.jobWho')}</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => {
                  const open = openId === job.id && Boolean(job.output)
                  return (
                    <JobRows
                      key={job.id}
                      job={job}
                      open={open}
                      when={when(job.finished_at || job.created_at)}
                      statusText={statusLabel(job.status, t)}
                      statusTone={statusClass(job.status)}
                      actionText={actionLabel(job.action, t)}
                      who={job.requested_by || '—'}
                      showLabel={t('serverAudit.jobShow')}
                      onToggle={() => setOpenId(open ? null : job.id)}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function JobRows({
  job,
  open,
  when,
  statusText,
  statusTone,
  actionText,
  who,
  showLabel,
  onToggle,
}: {
  job: ServerAuditJob
  open: boolean
  when: string
  statusText: string
  statusTone: string
  actionText: string
  who: string
  showLabel: string
  onToggle: () => void
}) {
  return (
    <>
      <tr>
        <td className="app-table-cell">
          <span className={`text-xs font-semibold ${statusTone}`}>{statusText}</span>
        </td>
        <td className="app-table-cell">{actionText}</td>
        <td className="app-table-cell max-w-[16rem] truncate font-mono text-xs" title={job.target}>
          {job.target}
          {job.exit_code != null ? <span className="ml-2 text-[var(--color-fg-subtle)]">{job.exit_code}</span> : null}
        </td>
        <td className="app-table-cell-muted">
          {who}
          {when ? <span className="mt-0.5 block text-[11px]">{when}</span> : null}
        </td>
        <td className="app-table-cell text-right">
          {job.output ? (
            <button type="button" className="app-chip !px-2.5 !py-1" onClick={onToggle}>
              {showLabel}
            </button>
          ) : null}
        </td>
      </tr>
      {open && job.output ? (
        <tr>
          <td colSpan={5} className="bg-[var(--color-bg-muted)] px-3 py-2">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">{job.output}</pre>
          </td>
        </tr>
      ) : null}
    </>
  )
}
