import { useEffect, useState } from 'react'
import { api, type ServerAuditActionCatalog, type ServerAuditJob, type ServerAuditJobAction } from '../api'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { AppFold } from '../components/ui/AppFold'
import { useT } from '../i18n/LocaleContext'

const EMPTY_CATALOG: ServerAuditActionCatalog = {
  tests: ['nginx', 'sshd'],
  restart: ['nginx', 'sshd'],
  read: ['/etc/nginx/nginx.conf'],
  write_prefixes: ['/etc/nginx/conf.d/'],
}

const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,80}$/
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

type RemoteAction = 'status' | 'show' | 'restart' | 'test'

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
  if (action === 'list') return t('serverAudit.actKindList')
  if (action === 'docker') return t('serverAudit.actKindDocker')
  if (action === 'playbook') return t('serverAudit.actKindPlaybook')
  return action
}

function parseList(output: string) {
  const rows: { kind: 'd' | 'f'; name: string }[] = []
  for (const line of output.split('\n')) {
    const match = /^([df]) ([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(line.trim())
    if (!match) continue
    rows.push({ kind: match[1] as 'd' | 'f', name: match[2] })
  }
  return rows
}

function parseDocker(output: string) {
  const rows: { name: string; status: string; image: string }[] = []
  for (const line of output.split('\n')) {
    const [name, status, image] = line.split('|')
    if (!name || !CONTAINER_RE.test(name.trim())) continue
    rows.push({ name: name.trim(), status: (status || '').trim(), image: (image || '').trim() })
  }
  return rows
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
  const [remoteAction, setRemoteAction] = useState<RemoteAction>('status')
  const [remoteTarget, setRemoteTarget] = useState('nginx')
  const [readPath, setReadPath] = useState('/etc/nginx/nginx.conf')
  const [writePrefix, setWritePrefix] = useState('/etc/nginx/conf.d/')
  const [writeName, setWriteName] = useState('corax.conf')
  const [fileBody, setFileBody] = useState('')
  const [folder, setFolder] = useState('')
  const [editPath, setEditPath] = useState('')
  const [filledReadId, setFilledReadId] = useState<number | null>(null)
  const [composePath, setComposePath] = useState('/etc/corax/compose/web')
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
          setRemoteTarget(picked)
        }
        if (rows.read[0]) setReadPath(rows.read[0])
        if (rows.write_prefixes[0]) setWritePrefix(rows.write_prefixes[0])
        if (rows.list_prefixes?.[0]) setFolder((current) => current || rows.list_prefixes?.[0] || '')
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!editPath) return
    const job = jobs.find((item) => item.action === 'read' && item.target === editPath && item.status === 'done' && item.output)
    if (!job || job.id === filledReadId) return
    setFileBody(job.output || '')
    setFilledReadId(job.id)
  }, [editPath, filledReadId, jobs])

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

  const requestTarget = remoteTarget.trim()
  const requestOk =
    remoteAction === 'test'
      ? requestTarget === 'nginx' || requestTarget === 'sshd'
      : UNIT_RE.test(requestTarget)
  const nameOk = FILE_RE.test(writeName.trim())
  const writePath = `${writePrefix}${writeName.trim()}`

  const listPrefixes = catalog.list_prefixes?.length ? catalog.list_prefixes : ['/etc/corax', '/etc/nginx']
  const composePrefixes = catalog.compose_prefixes?.length ? catalog.compose_prefixes : ['/etc/corax/compose']
  const listJob = jobs.find((job) => job.action === 'list' && job.target === folder && job.status === 'done' && job.output)
  const listed = parseList(listJob?.output || '')
  const dockerJob = jobs.find((job) => job.action === 'docker' && job.target === 'ps' && job.status === 'done' && job.output)
  const containers = parseDocker(dockerJob?.output || '')
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

  async function dockerVerb(verb: 'start' | 'stop' | 'restart', name: string) {
    const ok = await confirm.ask({
      title: t('serverAudit.dockerTitle'),
      body: t('serverAudit.dockerAsk', { verb, name }),
      confirmLabel: t('serverAudit.dockerRestart'),
      tone: 'danger',
    })
    if (!ok) return
    await onQueue('docker', verb, name)
  }

  async function composeVerb(verb: 'compose-up' | 'compose-down') {
    const path = composePath.trim().replace(/\/+$/, '')
    if (!path.startsWith('/etc/corax/compose/') && !path.startsWith('/opt/corax/compose/')) return
    const ok = await confirm.ask({
      title: t('serverAudit.dockerTitle'),
      body: t('serverAudit.dockerAsk', { verb, name: path }),
      confirmLabel: verb === 'compose-up' ? t('serverAudit.composeUp') : t('serverAudit.composeDown'),
      tone: 'danger',
    })
    if (!ok) return
    await onQueue('docker', verb, path)
  }

  async function sendRemote() {
    if (!requestOk) return
    if (remoteAction === 'restart') {
      await restartPicked(requestTarget)
      return
    }
    await onQueue(remoteAction, requestTarget)
  }

  return (
    <div className="flex flex-col gap-4">
      {confirm.dialog}
      {view === 'ops' ? (
        <div className="flex flex-col gap-4">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 p-4">
            <div className="text-sm font-semibold text-[var(--color-fg)]">{t('serverAudit.remoteTitle')}</div>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-subtle)]">{t('serverAudit.remoteLead')}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void onQueue('units', 'service')}>
                {t('serverAudit.playStepUnits')}
              </button>
              <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void onQueue('test', 'nginx')}>
                {t('serverAudit.actNginxTest')}
              </button>
              <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void onQueue('test', 'sshd')}>
                {t('serverAudit.actSshdTest')}
              </button>
              <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void onQueue('docker', 'ps')}>
                {t('serverAudit.dockerList')}
              </button>
            </div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
              <label className="flex min-w-[9rem] flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                {t('serverAudit.remoteAction')}
                <select
                  value={remoteAction}
                  onChange={(event) => setRemoteAction(event.target.value as RemoteAction)}
                  className="app-input app-select"
                >
                  <option value="status">{t('serverAudit.actKindStatus')}</option>
                  <option value="show">{t('serverAudit.actKindShow')}</option>
                  <option value="test">{t('serverAudit.actKindTest')}</option>
                  <option value="restart">{t('serverAudit.actKindRestart')}</option>
                </select>
              </label>
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                {t('serverAudit.remoteTarget')}
                <input
                  value={remoteTarget}
                  onChange={(event) => setRemoteTarget(event.target.value)}
                  list="server-audit-units"
                  className="app-input font-mono"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className={remoteAction === 'restart' ? 'app-btn app-btn-danger !min-h-0 !px-3 !py-2' : 'app-btn app-btn-primary !min-h-0 !px-3 !py-2'}
                disabled={busy || !requestOk}
                onClick={() => void sendRemote()}
              >
                {t('serverAudit.remoteSend')}
              </button>
            </div>
            <datalist id="server-audit-units">
              {catalog.restart.map((name) => (
                <option key={name} value={name} />
              ))}
              {units.map((unit) => (
                <option key={`live-${unit.name}`} value={unit.name} />
              ))}
            </datalist>
            {units.length > 0 ? (
              <div className="mt-3 grid max-h-48 gap-1 overflow-auto sm:grid-cols-2">
                {units.map((unit) => {
                  const on = unit.active === 'active'
                  const selected = picked === unit.name || remoteTarget === unit.name
                  return (
                    <button
                      key={unit.name}
                      type="button"
                      onClick={() => {
                        setPicked(unit.name)
                        setRemoteTarget(unit.name)
                        setRemoteAction('status')
                      }}
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
            ) : (
              <p className="mt-3 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.playEmpty')}</p>
            )}
            {shown?.output ? (
              <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-[11px] text-[var(--color-fg)]">{shown.output}</pre>
            ) : null}
          </div>
          <AppFold title={t('serverAudit.dockerTitle')}>
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                {containers.length === 0 ? <p className="text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.dockerEmpty')}</p> : <span />}
                <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void onQueue('docker', 'ps')}>
                  {t('serverAudit.dockerList')}
                </button>
              </div>
              {containers.length > 0 ? (
                <div className="flex max-h-56 flex-col gap-1 overflow-auto">
                  {containers.map((container) => (
                    <div key={container.name} className="flex flex-wrap items-center gap-2 rounded-lg bg-[var(--color-surface)] px-2 py-1.5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs text-[var(--color-fg)]">{container.name}</span>
                        <span className="block truncate text-[11px] text-[var(--color-fg-subtle)]">{container.status}{container.image ? ` · ${container.image}` : ''}</span>
                      </span>
                      <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 text-xs" disabled={busy} onClick={() => void dockerVerb('start', container.name)}>
                        {t('serverAudit.dockerStart')}
                      </button>
                      <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 text-xs" disabled={busy} onClick={() => void dockerVerb('stop', container.name)}>
                        {t('serverAudit.dockerStop')}
                      </button>
                      <button type="button" className="app-btn app-btn-danger !min-h-0 !px-2 !py-1 text-xs" disabled={busy} onClick={() => void dockerVerb('restart', container.name)}>
                        {t('serverAudit.dockerRestart')}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={composePath}
                  onChange={(event) => setComposePath(event.target.value)}
                  className="app-input min-w-0 flex-1 font-mono"
                  placeholder={`${composePrefixes[0]}/web`}
                  spellCheck={false}
                  aria-label={t('serverAudit.composePath')}
                />
                <button type="button" className="app-btn app-btn-primary !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void composeVerb('compose-up')}>
                  {t('serverAudit.composeUp')}
                </button>
                <button type="button" className="app-btn app-btn-danger !min-h-0 !px-3 !py-2" disabled={busy} onClick={() => void composeVerb('compose-down')}>
                  {t('serverAudit.composeDown')}
                </button>
              </div>
            </div>
          </AppFold>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-[var(--color-fg)]">{t('serverAudit.folderTitle')}</div>
            <select value={folder} onChange={(event) => setFolder(event.target.value)} className="app-input app-select min-w-0 flex-1 font-mono">
              {folder && !listPrefixes.includes(folder) ? <option value={folder}>{folder}</option> : null}
              {listPrefixes.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
            <button type="button" className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2" disabled={busy || !folder} onClick={() => void onQueue('list', folder)}>
              {t('serverAudit.folderList')}
            </button>
            <button
              type="button"
              className="app-btn app-btn-secondary !min-h-0 !px-3 !py-2"
              disabled={!folder || listPrefixes.includes(folder)}
              onClick={() => {
                const root = listPrefixes.find((prefix) => folder === prefix || folder.startsWith(`${prefix}/`))
                if (!root || folder === root) return
                const parent = folder.slice(0, folder.lastIndexOf('/'))
                setFolder(parent.length >= root.length ? parent : root)
              }}
            >
              {t('serverAudit.folderUp')}
            </button>
          </div>
          <p className="mt-2 truncate font-mono text-[11px] text-[var(--color-fg-subtle)]">{folder}</p>
          {listed.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-fg-subtle)]">{t('serverAudit.folderEmpty')}</p>
          ) : (
            <div className="mt-2 grid max-h-48 gap-1 overflow-auto sm:grid-cols-2">
              {listed.map((entry) => (
                <button
                  key={`${entry.kind}-${entry.name}`}
                  type="button"
                  className="truncate rounded-lg px-2 py-1 text-left font-mono text-xs hover:bg-[var(--color-surface)]"
                  onClick={() => {
                    const next = `${folder.replace(/\/+$/, '')}/${entry.name}`
                    if (entry.kind === 'd') {
                      setFolder(next)
                      void onQueue('list', next)
                      return
                    }
                    setEditPath(next)
                    setWriteName(entry.name)
                    const prefix = catalog.write_prefixes.find((item) => next.startsWith(item))
                    if (prefix) setWritePrefix(prefix)
                    void onQueue('read', next)
                  }}
                >
                  {entry.kind === 'd' ? '▸ ' : ''}
                  {entry.name}
                </button>
              ))}
            </div>
          )}
        </div>
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
                  onChange={(event) => {
                    setEditPath('')
                    setWriteName(event.target.value)
                  }}
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
                onClick={() => void onQueue('write', editPath || writePath, fileBody)}
              >
                {t('serverAudit.actWrite')}
              </button>
            </span>
          </div>
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
