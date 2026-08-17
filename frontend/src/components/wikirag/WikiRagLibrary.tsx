import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { api, type WikiRagDocumentRow } from '../../api'
import { IconFolder, IconTrash } from '../icons'
import { useLocale, useT } from '../../i18n/LocaleContext'
import { startWikiRagIndexJob } from '../../lib/wikiragIndexJob'
import { useToast } from '../../ToastContext'

function joinWikiPath(...parts: string[]) {
  return parts
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function docDir(filename: string) {
  const n = filename.replace(/\\/g, '/')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(0, i) : ''
}

function docBase(filename: string) {
  const n = filename.replace(/\\/g, '/')
  const i = n.lastIndexOf('/')
  return i >= 0 ? n.slice(i + 1) : n
}

function immediateChildFolders(allFolders: string[], current: string): string[] {
  const prefix = current ? `${current}/` : ''
  const names = new Set<string>()
  for (const f of allFolders) {
    if (current) {
      if (f === current || !f.startsWith(prefix)) continue
      const child = f.slice(prefix.length).split('/')[0]
      if (child) names.add(joinWikiPath(current, child))
    } else {
      const child = f.split('/')[0]
      if (child) names.add(child)
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

function countFilesUnder(rows: WikiRagDocumentRow[], folderPath: string) {
  const prefix = `${folderPath}/`
  return rows.filter((r) => {
    const n = r.original_filename.replace(/\\/g, '/')
    return n === folderPath || n.startsWith(prefix)
  }).length
}

function folderStats(rows: WikiRagDocumentRow[], folderPath: string) {
  const prefix = folderPath ? `${folderPath}/` : ''
  let ready = 0
  let pending = 0
  let error = 0
  let total = 0
  for (const r of rows) {
    const n = r.original_filename.replace(/\\/g, '/')
    const inFolder = folderPath
      ? n === folderPath || n.startsWith(prefix)
      : true
    if (!inFolder) continue
    total += 1
    const s = (r.index_status || 'pending').toLowerCase()
    if (s === 'ready') ready += 1
    else if (s === 'error') error += 1
    else pending += 1
  }
  return { total, ready, pending, error }
}

function formatBytes(n: number, t: ReturnType<typeof useT>) {
  if (n < 1024) return t('wikirag.common.bytes', { n })
  if (n < 1024 * 1024) return t('wikirag.common.kb', { n: (n / 1024).toFixed(1) })
  return t('wikirag.common.mb', { n: (n / (1024 * 1024)).toFixed(1) })
}

/** Opaque floating menu above the file list (portal → body, avoids sibling bleed-through). */
function WikiRagRowMenu({
  open,
  anchor,
  onClose,
  widthClass = 'w-44',
  children,
}: {
  open: boolean
  anchor: HTMLElement | null
  onClose: () => void
  widthClass?: string
  children: ReactNode
}) {
  const t = useT()
  const [pos, setPos] = useState({ top: 0, left: 0 })

  useLayoutEffect(() => {
    if (!open || !anchor) return
    const place = () => {
      const r = anchor.getBoundingClientRect()
      const menuW = widthClass.includes('40') ? 160 : 176
      const left = Math.min(Math.max(8, r.right - menuW), window.innerWidth - menuW - 8)
      setPos({ top: r.bottom + 4, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchor, widthClass])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <>
      <button
        type="button"
        className="fixed inset-0 z-[220] cursor-default bg-transparent"
        aria-label={t('wikirag.library.closeMenu')}
        onClick={onClose}
      />
      <div
        role="menu"
        className={`wikirag-fs-menu fixed z-[230] ${widthClass} overflow-hidden rounded-lg border border-[var(--color-border)] py-1 shadow-xl`}
        style={{ top: pos.top, left: pos.left }}
      >
        {children}
      </div>
    </>,
    document.body,
  )
}


function formatWhen(iso: string, locale: 'ru' | 'en') {
  try {
    return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function indexBadge(status: string | undefined, t: ReturnType<typeof useT>) {
  const s = (status || 'pending').toLowerCase()
  if (s === 'ready') {
    return {
      label: t('wikirag.documents.statusReady'),
      cls: 'bg-[var(--color-success-bg)] text-[var(--color-success-fg)]',
    }
  }
  if (s === 'error') {
    return { label: t('wikirag.documents.statusError'), cls: 'bg-red-500/10 text-red-700 dark:text-red-300' }
  }
  return {
    label: t('wikirag.documents.statusPending'),
    cls: 'wikirag-index-pending bg-blue-500/10 text-blue-800 dark:text-blue-200',
  }
}

function buildTreeNodes(folders: string[]): { path: string; name: string; depth: number }[] {
  const sorted = [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return sorted.map((path) => ({
    path,
    name: docBase(path),
    depth: path.split('/').length - 1,
  }))
}

type Props = {
  rows: WikiRagDocumentRow[]
  folders: string[]
  currentPath: string
  onPathChange: (path: string) => void
  canManage: boolean
  loading: boolean
  modalDocId: number | null
  onOpenDoc: (id: number) => void
  onReload: () => void | Promise<void>
  compact?: boolean
  fillHeight?: boolean
}

export function WikiRagLibrary({
  rows,
  folders,
  currentPath,
  onPathChange,
  canManage,
  loading,
  modalDocId,
  onOpenDoc,
  onReload,
  compact = false,
  fillHeight = false,
}: Props) {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const importRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ '': true })
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [renaming, setRenaming] = useState<null | { kind: 'folder' | 'file'; path: string; id?: number }>(null)
  const [renameValue, setRenameValue] = useState('')
  const [movingDoc, setMovingDoc] = useState<WikiRagDocumentRow | null>(null)
  const [moveTarget, setMoveTarget] = useState('')

  const childFolders = useMemo(
    () => immediateChildFolders(folders, currentPath),
    [folders, currentPath],
  )
  const filesHere = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter((r) => docDir(r.original_filename) === currentPath)
      .filter((r) => !q || docBase(r.original_filename).toLowerCase().includes(q))
      .sort((a, b) =>
        docBase(a.original_filename).localeCompare(docBase(b.original_filename), undefined, {
          sensitivity: 'base',
        }),
      )
  }, [rows, currentPath, query])

  const crumbs = useMemo(() => {
    if (!currentPath) return [] as { label: string; path: string }[]
    const parts = currentPath.split('/')
    return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }))
  }, [currentPath])

  const treeNodes = useMemo(() => buildTreeNodes(folders), [folders])
  const visibleTree = useMemo(() => {
    return treeNodes.filter((node) => {
      if (node.depth === 0) return true
      const parts = node.path.split('/')
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/')
        if (!expanded[parent]) return false
      }
      return true
    })
  }, [treeNodes, expanded])

  const hereStats = folderStats(rows, currentPath)

  async function onCreateFolder(e?: FormEvent) {
    e?.preventDefault()
    const name = newFolderName.trim().replace(/[\\/]+/g, '')
    if (!name) return
    setBusy(true)
    try {
      const path = currentPath ? joinWikiPath(currentPath, name) : name
      await api.createWikiRagFolder(path)
      setNewFolderName('')
      setCreatingFolder(false)
      toast.ok(t('wikirag.library.createOk', { path }))
      await onReload()
      onPathChange(path)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function onDeleteFolder(path: string) {
    const n = countFilesUnder(rows, path)
    const nested = folders.filter((f) => f === path || f.startsWith(`${path}/`)).length
    const msg =
      n > 0 || nested > 1
        ? t('wikirag.library.deleteFolderRecursiveConfirm', { path, n: Math.max(n, nested) })
        : t('wikirag.library.deleteFolderConfirm', { path })
    if (!window.confirm(msg)) return
    setBusy(true)
    setMenuFor(null)
    try {
      const res = await api.deleteWikiRagFolder(path, { recursive: true })
      toast.ok(
        t('wikirag.library.deleteFolderOk') +
          (res.deleted_documents ? ` (${res.deleted_documents})` : ''),
      )
      if (currentPath === path || currentPath.startsWith(`${path}/`)) {
        onPathChange(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
      }
      await onReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setBusy(false)
    }
  }

  function startRenameFolder(path: string) {
    setRenaming({ kind: 'folder', path })
    setRenameValue(docBase(path))
    setMenuFor(null)
  }

  function startRenameFile(row: WikiRagDocumentRow) {
    setRenaming({ kind: 'file', path: row.original_filename, id: row.id })
    setRenameValue(docBase(row.original_filename))
    setMenuFor(null)
  }

  async function submitRename(e?: FormEvent) {
    e?.preventDefault()
    if (!renaming) return
    const name = renameValue.trim().replace(/[\\/]+/g, '')
    if (!name) return
    setBusy(true)
    try {
      if (renaming.kind === 'folder') {
        const parent = renaming.path.includes('/')
          ? renaming.path.slice(0, renaming.path.lastIndexOf('/'))
          : ''
        const toPath = parent ? joinWikiPath(parent, name) : name
        await api.renameWikiRagFolder(renaming.path, toPath)
        if (currentPath === renaming.path || currentPath.startsWith(`${renaming.path}/`)) {
          onPathChange(
            currentPath === renaming.path
              ? toPath
              : toPath + currentPath.slice(renaming.path.length),
          )
        }
      } else if (renaming.id != null) {
        const parent = docDir(renaming.path)
        const next = parent ? joinWikiPath(parent, name) : name
        await api.updateWikiRagDocument(renaming.id, { original_filename: next })
      }
      toast.ok(t('wikirag.library.renameOk'))
      setRenaming(null)
      await onReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function submitMove(e?: FormEvent) {
    e?.preventDefault()
    if (!movingDoc) return
    setBusy(true)
    try {
      const base = docBase(movingDoc.original_filename)
      const next = moveTarget ? joinWikiPath(moveTarget, base) : base
      await api.updateWikiRagDocument(movingDoc.id, { original_filename: next })
      toast.ok(t('wikirag.library.moveOk'))
      setMovingDoc(null)
      await onReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setBusy(false)
    }
  }

  async function onDeleteFile(row: WikiRagDocumentRow) {
    if (!confirm(t('wikirag.documents.deleteConfirm', { name: row.original_filename }))) return
    setBusy(true)
    try {
      await api.deleteWikiRagDocument(row.id)
      await onReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setBusy(false)
      setMenuFor(null)
    }
  }

  async function onReindex(row: WikiRagDocumentRow) {
    try {
      startWikiRagIndexJob(1, [row.id])
      await api.reindexWikiRagDocument(row.id)
      toast.ok(t('wikirag.documents.reindexStarted'))
      await onReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    }
    setMenuFor(null)
  }

  async function onExport() {
    setExporting(true)
    try {
      await api.exportWikiRagIndex()
      toast.ok(t('wikirag.library.exportOk'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setExporting(false)
    }
  }

  async function onImportFile(file: File | null | undefined) {
    if (!file) return
    setImporting(true)
    try {
      const res = await api.importWikiRagIndex(file)
      toast.ok(t('wikirag.library.importOk', { docs: res.documents, chunks: res.chunks }))
      if (res.warnings?.length) {
        toast.info(t('wikirag.library.importWarn', { detail: res.warnings.join(' · ') }))
      }
      await onReload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
    } finally {
      setImporting(false)
      if (importRef.current) importRef.current.value = ''
    }
  }

  function toggleExpand(path: string) {
    setExpanded((prev) => ({ ...prev, [path]: !prev[path] }))
  }

  const filteredChildFolders = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return childFolders
    return childFolders.filter((p) => docBase(p).toLowerCase().includes(q))
  }, [childFolders, query])

  return (
    <section
      className={`rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm ${
        fillHeight ? 'flex h-full min-h-0 flex-col' : ''
      }`}
    >
      <div className="overflow-hidden rounded-t-2xl border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.library.title')}</h2>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{t('wikirag.library.subtitle')}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
              <span className="rounded-md bg-[var(--color-surface)] px-2 py-0.5 ring-1 ring-[var(--color-border)]">
                {t('wikirag.library.folderFiles', { n: hereStats.total })}
              </span>
              {hereStats.ready > 0 ? (
                <span className="rounded-md bg-[var(--color-success-bg)] px-2 py-0.5 text-[var(--color-success-fg)]">
                  {t('wikirag.library.readyShort', { n: hereStats.ready })}
                </span>
              ) : null}
              {hereStats.pending > 0 ? (
                <span className="rounded-md bg-blue-500/10 px-2 py-0.5 text-blue-800 dark:text-blue-200">
                  {t('wikirag.library.pendingShort', { n: hereStats.pending })}
                </span>
              ) : null}
              {hereStats.error > 0 ? (
                <span className="rounded-md bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-300">
                  {t('wikirag.library.errorShort', { n: hereStats.error })}
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canManage ? (
              <>
                <button
                  type="button"
                  disabled={exporting || busy}
                  onClick={() => void onExport()}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                >
                  {exporting ? t('wikirag.library.exportBusy') : t('wikirag.library.exportIndex')}
                </button>
                <button
                  type="button"
                  disabled={importing || busy}
                  onClick={() => importRef.current?.click()}
                  className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-xs font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
                >
                  {importing ? t('wikirag.library.importBusy') : t('wikirag.library.importIndex')}
                </button>
                <input
                  ref={importRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="sr-only"
                  onChange={(e) => void onImportFile(e.target.files?.[0])}
                />
                {creatingFolder ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void onCreateFolder(e)}>
                    <input
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      placeholder={t('wikirag.library.createFolderPlaceholder')}
                      className="app-input !min-h-0 w-40 !px-2.5 !py-1.5 !text-sm"
                      autoFocus
                      disabled={busy}
                    />
                    <button
                      type="submit"
                      disabled={busy || !newFolderName.trim()}
                      className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                    >
                      {t('wikirag.library.createFolderSubmit')}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setCreatingFolder(false)
                        setNewFolderName('')
                      }}
                      className="rounded-lg px-2 py-1.5 text-xs font-medium text-[var(--color-fg-muted)]"
                    >
                      {t('wikirag.library.createFolderCancel')}
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => setCreatingFolder(true)}
                    className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white"
                  >
                    {t('wikirag.library.createFolder')}
                  </button>
                )}
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <nav className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-xs" aria-label={t('wikirag.library.breadcrumb')}>
            <button
              type="button"
              onClick={() => onPathChange('')}
              className={`rounded-md px-2 py-1 font-medium transition ${
                currentPath
                  ? 'text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)]'
                  : 'bg-[var(--color-bg-muted)] text-[var(--color-fg)]'
              }`}
            >
              {t('wikirag.library.root')}
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="inline-flex items-center gap-1">
                <span className="text-[var(--color-fg-subtle)]">/</span>
                <button
                  type="button"
                  onClick={() => onPathChange(c.path)}
                  className={`rounded-md px-2 py-1 font-medium transition ${
                    c.path === currentPath
                      ? 'bg-[var(--color-bg-muted)] text-[var(--color-fg)]'
                      : 'text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)]'
                  }`}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('wikirag.library.searchPlaceholder')}
            className="app-input !min-h-0 w-full max-w-xs !px-2.5 !py-1.5 !text-sm sm:w-56"
          />
        </div>
      </div>

      {loading ? (
        <p className="p-6 text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
      ) : (
        <div
          className={`grid ${fillHeight ? 'min-h-0 flex-1 overflow-hidden' : 'min-h-[22rem]'} ${
            compact
              ? 'md:grid-cols-[11rem_minmax(0,1fr)]'
              : 'lg:grid-cols-[16.5rem_minmax(0,1fr)]'
          }`}
        >
          <aside
            className={`border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-muted)_40%,transparent)] ${
              fillHeight ? 'flex min-h-0 flex-col' : ''
            } ${compact ? 'md:border-b-0 md:border-r' : 'lg:border-b-0 lg:border-r'}`}
          >
            <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              {t('wikirag.library.treeTitle')}
            </p>
            <ul
              className={`${
                fillHeight ? 'min-h-0 flex-1' : compact ? 'max-h-[20rem]' : 'max-h-[28rem]'
              } space-y-0.5 overflow-y-auto px-2 pb-3`}
            >
              <li className="wikirag-fs-tree-item" style={{ ['--i' as string]: 0 }}>
                <button
                  type="button"
                  onClick={() => onPathChange('')}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-medium transition ${
                    !currentPath
                      ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                      : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  <IconFolder className="h-3.5 w-3.5 shrink-0 opacity-80" />
                  <span className="truncate">{t('wikirag.library.root')}</span>
                  <span className="ml-auto tabular-nums text-[10px] opacity-70">{rows.length}</span>
                </button>
              </li>
              {visibleTree.map((node, idx) => {
                const hasKids = folders.some((f) => f.startsWith(`${node.path}/`))
                const isOpen = Boolean(expanded[node.path])
                const active = currentPath === node.path || currentPath.startsWith(`${node.path}/`)
                const stats = folderStats(rows, node.path)
                return (
                  <li
                    key={node.path}
                    className="wikirag-fs-tree-item"
                    style={{
                      paddingLeft: `${Math.min(node.depth, 6) * 0.65 + 0.25}rem`,
                      ['--i' as string]: Math.min(idx + 1, 24),
                    }}
                  >
                    <div
                      className={`group flex items-center gap-0.5 rounded-lg transition-colors duration-200 ${
                        currentPath === node.path ? 'bg-[var(--color-primary-muted)]' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="flex h-7 w-5 shrink-0 items-center justify-center text-[10px] text-[var(--color-fg-subtle)] transition-transform duration-200"
                        onClick={() => (hasKids ? toggleExpand(node.path) : onPathChange(node.path))}
                        aria-label={
                          hasKids
                            ? isOpen
                              ? t('wikirag.library.collapse')
                              : t('wikirag.library.expand')
                            : t('wikirag.library.openFolder')
                        }
                      >
                        <span className={`inline-block transition-transform duration-200 ${hasKids && isOpen ? 'rotate-0' : ''}`}>
                          {hasKids ? (isOpen ? '▾' : '▸') : '·'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => onPathChange(node.path)}
                        className={`flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pr-2 text-left text-xs font-medium transition-colors ${
                          active ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                        }`}
                      >
                        <IconFolder className="h-3.5 w-3.5 shrink-0 text-[var(--color-primary)] opacity-90 transition-transform duration-200 group-hover:scale-110" />
                        <span className="truncate">{node.name}</span>
                        <span className="ml-auto shrink-0 tabular-nums text-[10px] opacity-60">{stats.total}</span>
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          </aside>

          <div className={`min-w-0 ${fillHeight ? 'flex min-h-0 flex-col overflow-hidden' : ''}`}>
            <div className="border-b border-[var(--color-border)] px-4 py-2 sm:px-5">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                {t('wikirag.library.filesHere')}
              </p>
            </div>

            {filteredChildFolders.length === 0 && filesHere.length === 0 ? (
              <p className="wikirag-fs-pane px-4 py-12 text-center text-sm text-[var(--color-fg-muted)] sm:px-5">
                {rows.length === 0 && folders.length === 0
                  ? t('wikirag.library.emptyLibrary')
                  : t('wikirag.library.emptyFolder')}
              </p>
            ) : (
              <ul key={currentPath || '__root__'} className={`wikirag-fs-pane divide-y divide-[var(--color-border)] ${fillHeight ? 'min-h-0 flex-1 overflow-y-auto' : ''}`}>
                {filteredChildFolders.map((folderPath, idx) => {
                  const stats = folderStats(rows, folderPath)
                  const menuId = `folder:${folderPath}`
                  return (
                    <li
                      key={folderPath}
                      className="wikirag-fs-row group relative flex items-center gap-3 px-4 py-2.5 transition hover:bg-[var(--color-primary-muted)]/35 sm:px-5"
                      style={{ ['--i' as string]: Math.min(idx, 20) }}
                    >
                      <button
                        type="button"
                        onClick={() => onPathChange(folderPath)}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-bg-muted)] text-[var(--color-primary)] ring-1 ring-[var(--color-border)] transition-transform duration-200 group-hover:scale-105">
                          <IconFolder className="h-5 w-5" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-[var(--color-fg)]">
                            {docBase(folderPath)}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-[var(--color-fg-muted)]">
                            {t('wikirag.library.folderLabel')} · {t('wikirag.library.folderFiles', { n: stats.total })}
                            {stats.pending > 0
                              ? ` · ${t('wikirag.library.pendingShort', { n: stats.pending })}`
                              : ''}
                          </span>
                        </span>
                      </button>
                      {canManage ? (
                        <div className="relative shrink-0">
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-bold text-[var(--color-fg-muted)] opacity-80 transition hover:bg-[var(--color-surface)] hover:opacity-100"
                            disabled={busy}
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              setMenuAnchor(e.currentTarget)
                              setMenuFor(menuFor === menuId ? null : menuId)
                            }}
                            aria-label={t('wikirag.library.actions')}
                          >
                            ⋯
                          </button>
                          <WikiRagRowMenu
                            open={menuFor === menuId}
                            anchor={menuAnchor}
                            onClose={() => setMenuFor(null)}
                          >
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                startRenameFolder(folderPath)
                              }}
                            >
                              {t('wikirag.library.rename')}
                            </button>
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-xs text-red-700 hover:bg-red-500/10 dark:text-red-300"
                              disabled={busy}
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                void onDeleteFolder(folderPath)
                              }}
                            >
                              {t('wikirag.library.deleteFolder')}
                            </button>
                          </WikiRagRowMenu>
                        </div>
                      ) : null}
                    </li>
                  )
                })}

                {filesHere.map((row, idx) => {
                  const badge = indexBadge(row.index_status, t)
                  const menuId = `file:${row.id}`
                  const active = modalDocId === row.id
                  return (
                    <li
                      key={row.id}
                      className={`wikirag-fs-row group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-4 py-2.5 transition sm:px-5 ${
                        active
                          ? 'bg-[var(--color-primary-muted)]'
                          : 'hover:bg-[color-mix(in_srgb,var(--color-bg-muted)_55%,transparent)]'
                      }`}
                      style={{ ['--i' as string]: Math.min(filteredChildFolders.length + idx, 28) }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMenuFor(null)
                          onOpenDoc(row.id)
                        }}
                        className="flex min-w-0 items-center gap-3 text-left"
                        title={row.original_filename}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-surface)] text-[11px] font-bold uppercase tracking-wide text-[var(--color-fg-muted)] ring-1 ring-[var(--color-border)]">
                          {docBase(row.original_filename).split('.').pop()?.slice(0, 4) || 'file'}
                        </span>
                        <span className="min-w-0 flex-1 overflow-hidden">
                          <span className="block truncate text-sm font-medium text-[var(--color-primary)]">
                            {docBase(row.original_filename)}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--color-fg-muted)]">
                            <span>
                              {formatBytes(row.size_bytes, t)} · {formatWhen(row.created_at, locale)}
                            </span>
                            <span
                              className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badge.cls}`}
                            >
                              {badge.label}
                            </span>
                          </span>
                        </span>
                      </button>
                      {canManage ? (
                        <div className="relative shrink-0 justify-self-end">
                          <button
                            type="button"
                            className="rounded-lg px-2 py-1 text-xs font-bold text-[var(--color-fg-muted)] opacity-70 transition hover:bg-[var(--color-surface)] group-hover:opacity-100"
                            onClick={(e) => {
                              setMenuAnchor(e.currentTarget)
                              setMenuFor(menuFor === menuId ? null : menuId)
                            }}
                            aria-label={t('wikirag.library.actions')}
                          >
                            ⋯
                          </button>
                          <WikiRagRowMenu
                            open={menuFor === menuId}
                            anchor={menuAnchor}
                            onClose={() => setMenuFor(null)}
                            widthClass="w-40"
                          >
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
                              onClick={() => startRenameFile(row)}
                            >
                              {t('wikirag.library.rename')}
                            </button>
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
                              onClick={() => {
                                setMovingDoc(row)
                                setMoveTarget(docDir(row.original_filename))
                                setMenuFor(null)
                              }}
                            >
                              {t('wikirag.library.move')}
                            </button>
                            <a
                              href={api.wikiRagFileUrl(row.id)}
                              className="block w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] no-underline hover:bg-[var(--color-bg-muted)]"
                              download
                              onClick={() => setMenuFor(null)}
                            >
                              {t('wikirag.library.download')}
                            </a>
                            <button
                              type="button"
                              className="block w-full px-3 py-1.5 text-left text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-muted)]"
                              onClick={() => void onReindex(row)}
                            >
                              {t('wikirag.library.reindexShort')}
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-700 hover:bg-red-500/10 dark:text-red-300"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                void onDeleteFile(row)
                              }}
                            >
                              <IconTrash className="h-3.5 w-3.5" />
                              {t('wikirag.documents.deleteAria')}
                            </button>
                          </WikiRagRowMenu>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      )}

      {renaming ? (
        <div
          className="fixed inset-0 z-[240] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setRenaming(null)}
        >
          <form
            className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void submitRename(e)}
          >
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.library.rename')}</h3>
            <input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              className="app-input mt-3 w-full !text-sm"
              placeholder={t('wikirag.library.renamePlaceholder')}
              autoFocus
              disabled={busy}
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs text-[var(--color-fg-muted)]"
                onClick={() => setRenaming(null)}
              >
                {t('wikirag.library.createFolderCancel')}
              </button>
              <button
                type="submit"
                disabled={busy || !renameValue.trim()}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {t('wikirag.library.rename')}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {movingDoc ? (
        <div
          className="fixed inset-0 z-[240] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm"
          onClick={() => setMovingDoc(null)}
        >
          <form
            className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => void submitMove(e)}
          >
            <h3 className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.library.moveTitle')}</h3>
            <p className="mt-1 truncate text-xs text-[var(--color-fg-muted)]">{movingDoc.original_filename}</p>
            <select
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
              className="app-input mt-3 w-full !text-sm"
              disabled={busy}
            >
              <option value="">{t('wikirag.library.root')}</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-xs text-[var(--color-fg-muted)]"
                onClick={() => setMovingDoc(null)}
              >
                {t('wikirag.library.createFolderCancel')}
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                {t('wikirag.library.moveSubmit')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  )
}
