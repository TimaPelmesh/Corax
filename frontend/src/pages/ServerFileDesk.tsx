import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ServerAuditActionCatalog, type ServerAuditJob, type ServerAuditJobAction } from '../api'
import { useT } from '../i18n/LocaleContext'

const EMPTY: ServerAuditActionCatalog = {
  tests: [],
  restart: [],
  read: [],
  write_prefixes: ['/etc/nginx/conf.d/'],
  list_prefixes: ['/etc/nginx', '/etc/corax'],
}

function parseList(output: string) {
  const rows: { kind: 'd' | 'f'; name: string }[] = []
  for (const line of output.split('\n')) {
    const match = /^([df]) ([A-Za-z0-9][A-Za-z0-9._-]{0,120})$/.exec(line.trim())
    if (!match) continue
    rows.push({ kind: match[1] as 'd' | 'f', name: match[2] })
  }
  rows.sort((a, b) => Number(a.kind === 'f') - Number(b.kind === 'f') || a.name.localeCompare(b.name))
  return rows
}

function rootOf(path: string, roots: string[]) {
  return [...roots].sort((a, b) => b.length - a.length).find((root) => path === root || path.startsWith(`${root}/`)) ?? null
}

function crumbs(path: string) {
  const parts = path.split('/').filter(Boolean)
  const out: { name: string; path: string }[] = []
  let current = ''
  for (const part of parts) {
    current += `/${part}`
    out.push({ name: part, path: current })
  }
  return out
}

function writable(path: string, prefixes: string[]) {
  return prefixes.some((prefix) => {
    const root = prefix.endsWith('/') ? prefix : `${prefix}/`
    return path.startsWith(root) && !path.endsWith('/')
  })
}

export function ServerFileDesk({
  jobs,
  busy,
  onQueue,
}: {
  jobs: ServerAuditJob[]
  busy: boolean
  onQueue: (action: ServerAuditJobAction, target: string, body?: string) => Promise<void>
}) {
  const t = useT()
  const [catalog, setCatalog] = useState<ServerAuditActionCatalog>(EMPTY)
  const [folder, setFolder] = useState('')
  const [editPath, setEditPath] = useState('')
  const [body, setBody] = useState('')
  const [dirty, setDirty] = useState(false)
  const [filledId, setFilledId] = useState<number | null>(null)
  const asked = useRef(new Set<string>())

  useEffect(() => {
    let alive = true
    api
      .serverAuditActions()
      .then((rows) => {
        if (!alive) return
        setCatalog(rows)
        const first = rows.list_prefixes?.[0] || '/etc/nginx'
        setFolder((current) => current || first)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const roots = catalog.list_prefixes?.length ? catalog.list_prefixes : EMPTY.list_prefixes || []
  const root = rootOf(folder, roots)
  const lists = useMemo(
    () => jobs.filter((job) => job.action === 'list' && job.target === folder),
    [folder, jobs],
  )
  const pendingList = lists.find((job) => job.status === 'pending' || job.status === 'leased')
  const doneList = lists.find((job) => job.status === 'done')
  const failedList = lists.find((job) => job.status === 'failed' || job.status === 'expired')
  const entries = parseList(doneList?.output || '')
  const reads = jobs.filter((job) => job.action === 'read' && job.target === editPath)
  const pendingRead = reads.find((job) => job.status === 'pending' || job.status === 'leased')
  const canWrite = Boolean(editPath) && writable(editPath, catalog.write_prefixes || [])

  useEffect(() => {
    if (!folder || asked.current.has(folder)) return
    asked.current.add(folder)
    void onQueue('list', folder)
  }, [folder, onQueue])

  useEffect(() => {
    if (!editPath || dirty) return
    const job = reads.find((item) => item.status === 'done')
    if (!job || job.id === filledId) return
    setBody(job.output || '')
    setFilledId(job.id)
  }, [dirty, editPath, filledId, reads])

  function openFolder(next: string) {
    if (!rootOf(next, roots)) return
    setFolder(next)
  }

  function openFile(path: string) {
    setEditPath(path)
    setDirty(false)
    setFilledId(null)
    setBody('')
    void onQueue('read', path)
  }

  async function save() {
    if (!editPath || !canWrite) return
    await onQueue('write', editPath, body)
  }

  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : ''
  const canUp = Boolean(root && parent && parent.length >= root.length)

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="grid min-h-[32rem] lg:grid-cols-[14.5rem_minmax(0,1fr)]">
        <aside className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3 lg:border-b-0 lg:border-r">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {t('serverAudit.deskPlaces')}
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {roots.map((path) => {
              const active = folder === path || folder.startsWith(`${path}/`)
              const label = path.split('/').filter(Boolean).slice(-2).join('/') || path
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => openFolder(path)}
                  className={`truncate rounded-lg px-2 py-1.5 text-left font-mono text-xs ${
                    active
                      ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]'
                  }`}
                  title={path}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-fg-subtle)]">{t('serverAudit.deskHint')}</p>
        </aside>

        <div className="flex min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-1 border-b border-[var(--color-border)] px-3 py-2">
            <button
              type="button"
              className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 text-xs"
              disabled={!canUp}
              onClick={() => canUp && openFolder(parent)}
            >
              {t('serverAudit.deskUp')}
            </button>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 font-mono text-xs">
              {crumbs(folder).map((crumb, index, all) => {
                const allowed = rootOf(crumb.path, roots)
                const last = index === all.length - 1
                return (
                  <span key={crumb.path} className="flex min-w-0 items-center gap-1">
                    {index > 0 ? <span className="text-[var(--color-fg-subtle)]">/</span> : null}
                    <button
                      type="button"
                      disabled={!allowed || last}
                      onClick={() => openFolder(crumb.path)}
                      className={`truncate ${last ? 'font-semibold text-[var(--color-fg)]' : 'text-[var(--color-primary)] hover:underline'} disabled:no-underline`}
                    >
                      {crumb.name}
                    </button>
                  </span>
                )
              })}
            </div>
            <button
              type="button"
              className="app-btn app-btn-secondary !min-h-0 !px-2 !py-1 text-xs"
              disabled={busy || !folder}
              onClick={() => void onQueue('list', folder)}
            >
              {t('serverAudit.deskRefresh')}
            </button>
          </div>

          <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
            <div className="max-h-[28rem] overflow-auto border-b border-[var(--color-border)] lg:max-h-none lg:border-b-0 lg:border-r">
              {pendingList && !doneList ? (
                <p className="px-3 py-4 text-sm text-[var(--color-fg-muted)]">{t('serverAudit.deskWaiting')}</p>
              ) : failedList && !doneList ? (
                <p className="px-3 py-4 text-sm text-[var(--color-fg-muted)]">{t('serverAudit.deskFailed')}</p>
              ) : entries.length === 0 ? (
                <p className="px-3 py-4 text-sm text-[var(--color-fg-muted)]">{t('serverAudit.deskEmpty')}</p>
              ) : (
                <ul>
                  {entries.map((entry) => {
                    const path = `${folder.replace(/\/+$/, '')}/${entry.name}`
                    const active = editPath === path
                    return (
                      <li key={`${entry.kind}-${entry.name}`}>
                        <button
                          type="button"
                          onClick={() => (entry.kind === 'd' ? openFolder(path) : openFile(path))}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-surface-muted)] ${
                            active ? 'bg-[var(--color-primary-muted)]' : ''
                          }`}
                        >
                          <span className="w-4 shrink-0 text-xs text-[var(--color-fg-subtle)]" aria-hidden>
                            {entry.kind === 'd' ? '▸' : '·'}
                          </span>
                          <span className="min-w-0 truncate font-mono text-xs text-[var(--color-fg)]">{entry.name}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
              {pendingList && doneList ? (
                <p className="px-3 py-2 text-[11px] text-[var(--color-fg-subtle)]">{t('serverAudit.deskWaiting')}</p>
              ) : null}
            </div>

            <div className="flex min-h-[16rem] flex-col">
              {editPath ? (
                <>
                  <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2">
                    <div className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-fg)]" title={editPath}>
                      {editPath.split('/').pop()}
                    </div>
                    {canWrite ? null : (
                      <span className="text-[11px] font-medium text-[var(--color-fg-subtle)]">{t('serverAudit.deskReadOnly')}</span>
                    )}
                    <button
                      type="button"
                      className="app-btn app-btn-primary !min-h-0 !px-2.5 !py-1 text-xs"
                      disabled={busy || !canWrite || !dirty}
                      onClick={() => void save()}
                    >
                      {t('serverAudit.deskSave')}
                    </button>
                  </div>
                  {pendingRead && !body ? (
                    <p className="px-3 py-4 text-sm text-[var(--color-fg-muted)]">{t('serverAudit.deskWaiting')}</p>
                  ) : (
                    <textarea
                      value={body}
                      readOnly={!canWrite}
                      onChange={(event) => {
                        setBody(event.target.value)
                        setDirty(true)
                      }}
                      spellCheck={false}
                      className="min-h-0 flex-1 resize-none border-0 bg-transparent p-3 font-mono text-xs leading-relaxed text-[var(--color-fg)] outline-none"
                      aria-label={editPath}
                    />
                  )}
                </>
              ) : (
                <div className="grid flex-1 place-items-center px-6 text-center text-sm text-[var(--color-fg-muted)]">
                  {t('serverAudit.deskPick')}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
