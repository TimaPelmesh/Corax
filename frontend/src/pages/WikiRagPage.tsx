import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type WikiRagCoraxImportResult, type WikiRagDocumentRow } from '../api'
import { useAuth } from '../AuthContext'
import { WikiRagChat } from '../components/wikirag/WikiRagChat'
import { WikiRagDocViewer } from '../components/wikirag/WikiRagDocViewer'
import { WikiRagLibrary } from '../components/wikirag/WikiRagLibrary'
import { IconClose, IconFolder } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import {
  getWikiRagIndexJob,
  startWikiRagIndexJob,
  subscribeWikiRagIndexJob,
  syncWikiRagIndexJobFromDocs,
} from '../lib/wikiragIndexJob'
import { useToast } from '../ToastContext'

const ACCEPT =
  '.pdf,.txt,.md,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,application/pdf,text/plain'

const ALLOWED_EXT = new Set([
  '.pdf', '.txt', '.md', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.webp',
])

const MAX_FOLDER_FILES = 2500
/** Параллельные HTTP-загрузки — быстрее последовательной заливки больших папок. */
const UPLOAD_CONCURRENCY = 6

function fileExtension(name: string) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isAllowedFile(file: File) {
  return ALLOWED_EXT.has(fileExtension(file.name))
}

function relativePathOf(file: File) {
  const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath?.trim()
  return rel ? rel.replace(/\\/g, '/') : file.name
}

function joinWikiPath(...parts: string[]) {
  return parts
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

function uploadPathFor(file: File, currentFolder: string) {
  const rel = relativePathOf(file)
  return currentFolder ? joinWikiPath(currentFolder, rel) : rel
}

function folderRootName(files: File[]) {
  const rel = relativePathOf(files[0] || new File([], ''))
  const slash = rel.indexOf('/')
  return slash > 0 ? rel.slice(0, slash) : null
}

function collectFolderPrefixes(files: File[], currentFolder: string): string[] {
  const set = new Set<string>()
  for (const file of files) {
    const rel = uploadPathFor(file, currentFolder)
    const parts = rel.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      set.add(parts.slice(0, i).join('/'))
    }
  }
  return Array.from(set).sort((a, b) => {
    const da = a.split('/').length
    const db = b.split('/').length
    return da - db || a.localeCompare(b)
  })
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (!items.length) return
  let cursor = 0
  const run = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await worker(items[i], i)
    }
  }
  const n = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: n }, () => run()))
}

type FsEntry = {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, err?: (e: DOMException) => void) => void
  createReader?: () => {
    readEntries: (ok: (entries: FsEntry[]) => void, err?: (e: DOMException) => void) => void
  }
}

function withRelativePath(file: File, rel: string): File {
  try {
    Object.defineProperty(file, 'webkitRelativePath', {
      value: rel.replace(/\\/g, '/'),
      configurable: true,
    })
  } catch {
    /* ignore */
  }
  return file
}

async function readAllDirectoryEntries(
  reader: ReturnType<NonNullable<FsEntry['createReader']>>,
) {
  const out: FsEntry[] = []
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject)
    })
    if (!batch.length) break
    out.push(...batch)
  }
  return out
}

async function walkEntry(entry: FsEntry, prefix: string, files: File[], emptyFolders: string[]) {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file!(resolve, reject))
    const rel = prefix ? `${prefix}/${file.name}` : file.name
    files.push(withRelativePath(file, rel))
    return
  }
  if (entry.isDirectory && entry.createReader) {
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
    const children = await readAllDirectoryEntries(entry.createReader())
    if (!children.length) {
      emptyFolders.push(nextPrefix)
      return
    }
    let sawFile = false
    for (const child of children) {
      const before = files.length
      await walkEntry(child, nextPrefix, files, emptyFolders)
      if (files.length > before) sawFile = true
    }
    if (!sawFile && !emptyFolders.includes(nextPrefix)) emptyFolders.push(nextPrefix)
  }
}

async function collectFromDataTransfer(dt: DataTransfer): Promise<{ files: File[]; emptyFolders: string[] }> {
  const items = Array.from(dt.items || [])
  const entries: FsEntry[] = []
  for (const item of items) {
    const getEntry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry
    const entry = getEntry?.call(item) ?? null
    if (entry) entries.push(entry)
  }
  if (!entries.length) {
    return { files: Array.from(dt.files || []), emptyFolders: [] }
  }
  const files: File[] = []
  const emptyFolders: string[] = []
  for (const entry of entries) {
    await walkEntry(entry, '', files, emptyFolders)
  }
  return { files, emptyFolders }
}

function formatBytes(n: number, t: ReturnType<typeof useT>) {
  if (n < 1024) return t('wikirag.common.bytes', { n })
  if (n < 1024 * 1024) return t('wikirag.common.kb', { n: (n / 1024).toFixed(1) })
  return t('wikirag.common.mb', { n: (n / (1024 * 1024)).toFixed(1) })
}

export function WikiRagPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [rows, setRows] = useState<WikiRagDocumentRow[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploadComment, setUploadComment] = useState('')
  const [uploading, setUploading] = useState(false)
  const [importingCorax, setImportingCorax] = useState(false)
  const [reindexingAll, setReindexingAll] = useState(false)
  const [coraxSnapshot, setCoraxSnapshot] = useState<WikiRagCoraxImportResult | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [skippedCount, setSkippedCount] = useState(0)
  const [uploadProgress, setUploadProgress] = useState<{
    done: number
    total: number
    phase: 'folders' | 'files'
    folderDone?: number
    folderTotal?: number
  } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [readingDrop, setReadingDrop] = useState(false)
  const [modalDocId, setModalDocId] = useState<number | null>(null)
  const [knowledgeOpen, setKnowledgeOpen] = useState(false)
  const [uploadPanelOpen, setUploadPanelOpen] = useState(false)
  const [autoIndex, setAutoIndex] = useState(false)
  const [embedModel, setEmbedModel] = useState('bge-m3')
  const [embedModels, setEmbedModels] = useState<string[]>([])
  const [indexJob, setIndexJob] = useState(() => getWikiRagIndexJob())
  const fileRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)

  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')
  const modalDoc = rows.find((r) => r.id === modalDocId) ?? null
  const indexJobActive = indexJob.active


  const pickFiles = useCallback(
    (list: FileList | File[] | null | undefined) => {
      if (!list || list.length === 0) return
      const incoming = Array.from(list)
      if (incoming.length > MAX_FOLDER_FILES) {
        toast.error(t('wikirag.upload.tooMany', { max: MAX_FOLDER_FILES }))
        return
      }
      const allowed: File[] = []
      let skipped = 0
      for (const f of incoming) {
        if (isAllowedFile(f)) allowed.push(f)
        else skipped += 1
      }
      if (!allowed.length) {
        toast.error(t('wikirag.common.invalidFileType'))
        return
      }
      setSelectedFiles(allowed)
      setSkippedCount(skipped)
      setUploadPanelOpen(true)
    },
    [t, toast],
  )

  const clearSelectedFiles = useCallback(() => {
    setSelectedFiles([])
    setSkippedCount(0)
    setUploadProgress(null)
    if (fileRef.current) fileRef.current.value = ''
    if (folderRef.current) folderRef.current.value = ''
  }, [])

  const load = useCallback(async () => {
    try {
      const [list, folderRes, indexSettings] = await Promise.all([
        api.wikiRagDocuments(),
        api.wikiRagFolders().catch(() => ({ folders: [] as string[] })),
        api.wikiRagIndexSettings().catch(() => ({ auto_index: false, embed_model: 'bge-m3' })),
      ])
      setRows(list)
      setFolders(folderRes.folders || [])
      setAutoIndex(Boolean(indexSettings.auto_index))
      setEmbedModel((indexSettings.embed_model || 'bge-m3').trim() || 'bge-m3')
      syncWikiRagIndexJobFromDocs(list)
      if (modalDocId && !list.some((r) => r.id === modalDocId)) setModalDocId(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.loadingError'))
    } finally {
      setLoading(false)
    }
  }, [modalDocId, t, toast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void api
      .wikiRagLmStudioStatus()
      .then((st) => setEmbedModels(st.models || []))
      .catch(() => undefined)
  }, [])

  useEffect(() => subscribeWikiRagIndexJob(() => setIndexJob(getWikiRagIndexJob())), [])

  useEffect(() => {
    // Light refresh while on the page; global WikiRagIndexWatcher keeps the job alive off-page.
    if (!indexJobActive) return
    const timer = window.setInterval(() => {
      void load()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [load, indexJobActive])

  useEffect(() => {
    if (!modalDocId && !knowledgeOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (modalDocId) setModalDocId(null)
      else setKnowledgeOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [knowledgeOpen, modalDocId])

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
    setUploadPanelOpen(true)
  }
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragOver(false)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOver(false)
    if (uploading || readingDrop) return
    const dt = e.dataTransfer
    void (async () => {
      setReadingDrop(true)
      try {
        const { files, emptyFolders } = await collectFromDataTransfer(dt)
        if (canManage && emptyFolders.length) {
          for (const folder of emptyFolders) {
            const path = currentPath ? joinWikiPath(currentPath, folder) : folder
            try {
              await api.createWikiRagFolder(path)
            } catch {
              /* ignore duplicates / race */
            }
          }
          await load()
        }
        if (files.length) pickFiles(files)
        else if (!emptyFolders.length) toast.error(t('wikirag.common.selectFile'))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('wikirag.common.genericError'))
        pickFiles(dt.files)
      } finally {
        setReadingDrop(false)
      }
    })()
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    if (!selectedFiles.length) {
      toast.error(t('wikirag.common.selectFile'))
      return
    }
    const files = [...selectedFiles]
    const comment = uploadComment
    const folderPaths = collectFolderPrefixes(files, currentPath)
    setUploading(true)
    setUploadProgress({
      done: 0,
      total: files.length,
      phase: folderPaths.length ? 'folders' : 'files',
      folderDone: 0,
      folderTotal: folderPaths.length,
    })
    let ok = 0
    let fail = 0
    let lastId: number | null = null
    const uploadedIds: number[] = []
    try {
      if (folderPaths.length) {
        const maxDepth = Math.max(...folderPaths.map((p) => p.split('/').length))
        let folderDone = 0
        for (let depth = 1; depth <= maxDepth; depth++) {
          const batch = folderPaths.filter((p) => p.split('/').length === depth)
          if (!batch.length) continue
          await Promise.all(
            batch.map((path) =>
              api.createWikiRagFolder(path).catch(() => null),
            ),
          )
          folderDone += batch.length
          setUploadProgress({
            done: 0,
            total: files.length,
            phase: 'folders',
            folderDone,
            folderTotal: folderPaths.length,
          })
          await load()
          await new Promise((r) => window.setTimeout(r, 90))
        }
      }

      setUploadProgress({
        done: 0,
        total: files.length,
        phase: 'files',
        folderDone: folderPaths.length,
        folderTotal: folderPaths.length,
      })

      let done = 0
      await mapPool(files, UPLOAD_CONCURRENCY, async (file) => {
        try {
          const created = await api.uploadWikiRagDocument(file, comment, uploadPathFor(file, currentPath))
          ok += 1
          lastId = created.id
          uploadedIds.push(created.id)
        } catch {
          fail += 1
        }
        done += 1
        setUploadProgress({
          done,
          total: files.length,
          phase: 'files',
          folderDone: folderPaths.length,
          folderTotal: folderPaths.length,
        })
        if (done % Math.max(4, UPLOAD_CONCURRENCY) === 0) {
          void load()
        }
      })

      setUploadComment('')
      clearSelectedFiles()
      await load()
      if (autoIndex && uploadedIds.length) startWikiRagIndexJob(uploadedIds.length, uploadedIds)
      if (lastId) setModalDocId(lastId)
      if (fail === 0) toast.ok(t('wikirag.upload.doneOk', { ok }))
      else toast.info(t('wikirag.upload.donePartial', { ok, fail }))
    } finally {
      setUploading(false)
      setUploadProgress(null)
    }
  }


  async function onImportCorax() {
    setUploadPanelOpen(true)
    setImportingCorax(true)
    try {
      const res = await api.importWikiRagCorax()
      setCoraxSnapshot(res)
      toast.ok(
        t('wikirag.import.summary', {
          action: res.created ? t('wikirag.common.created') : t('wikirag.common.updated'),
          files: res.files ?? res.documents?.length ?? 1,
          computers: res.computers,
          requests: res.requests,
          tags: res.tags,
        }),
      )
      toast.info(t('wikirag.import.pendingHint'))
      await load()
      // CORAX import never starts indexing — only leaves files pending.
      setModalDocId(res.document.id)
    } catch (ex) {
      const msg = ex instanceof Error ? ex.message : t('wikirag.common.importFailed')
      toast.error(msg === 'Method Not Allowed' ? t('wikirag.common.importMethodNotAllowed') : msg)
    } finally {
      setImportingCorax(false)
    }
  }

  async function onReindexPending() {
    const targets = rows.filter((r) => {
      const s = (r.index_status || 'pending').toLowerCase()
      return s !== 'ready'
    })
    if (!targets.length) {
      toast.info(t('wikirag.documents.reindexPendingShort'))
      return
    }
    setReindexingAll(true)
    startWikiRagIndexJob(
      targets.length,
      targets.map((r) => r.id),
    )
    try {
      const res = await api.reindexPendingWikiRagDocuments()
      toast.ok(
        res.total
          ? t('wikirag.documents.reindexStarted')
          : t('wikirag.documents.reindexPendingShort'),
      )
      await load()
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : t('wikirag.common.genericError'))
    } finally {
      setReindexingAll(false)
    }
  }

  async function onReindexAll() {
    if (
      !window.confirm(
        `${t('wikirag.documents.reindexAll')}\n\n${t('wikirag.documents.reindexAllHint')}`,
      )
    ) {
      return
    }
    setReindexingAll(true)
    startWikiRagIndexJob(Math.max(rows.length, 1))
    try {
      await api.reindexAllWikiRagDocuments()
      toast.ok(t('wikirag.documents.reindexStarted'))
      await load()
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : t('wikirag.common.genericError'))
    } finally {
      setReindexingAll(false)
    }
  }

  const indexStats = {
    total: rows.length,
    ready: rows.filter((r) => (r.index_status || '').toLowerCase() === 'ready').length,
    pending: rows.filter((r) => (r.index_status || 'pending').toLowerCase() === 'pending').length,
    error: rows.filter((r) => (r.index_status || '').toLowerCase() === 'error').length,
  }
  const needIndex = indexStats.pending + indexStats.error
  const trackIds = indexJob.trackIds
  const trackedRows = trackIds?.length ? rows.filter((r) => trackIds.includes(r.id)) : rows
  const trackedPending = trackedRows.filter((r) => {
    const s = (r.index_status || 'pending').toLowerCase()
    return s !== 'ready' && s !== 'error'
  }).length
  const trackedDone = trackedRows.filter((r) => {
    const s = (r.index_status || '').toLowerCase()
    return s === 'ready' || s === 'error'
  }).length
  // Job scope: tracked ids, else baseline from start — never whole library by accident.
  const indexProgressTotal = Math.max(
    trackIds?.length || 0,
    indexJob.baseline || 0,
    indexJobActive ? 1 : needIndex || 1,
  )
  const indexProgressDone = Math.min(
    indexJobActive
      ? trackIds?.length
        ? trackedDone
        : Math.max(0, indexProgressTotal - trackedPending)
      : indexStats.ready + indexStats.error,
    indexProgressTotal,
  )
  const indexProgressPct = Math.round((indexProgressDone / indexProgressTotal) * 100)
  const showIndexBanner = indexJobActive

  async function onToggleAutoIndex(next: boolean) {
    if (!canManage) return
    try {
      const res = await api.updateWikiRagIndexSettings({ auto_index: next })
      setAutoIndex(Boolean(res.auto_index))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    }
  }

  async function onChangeEmbedModel(next: string) {
    if (!canManage) return
    const cleaned = next.trim() || 'bge-m3'
    setEmbedModel(cleaned)
    try {
      const res = await api.updateWikiRagIndexSettings({ embed_model: cleaned })
      setEmbedModel((res.embed_model || 'bge-m3').trim() || 'bge-m3')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    }
  }

  const embedSelectOptions =
    embedModels.includes(embedModel) || !embedModel ? embedModels : [embedModel, ...embedModels]

  return (
    <div className="relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
      <div className="wikirag-workspace min-h-0 flex-1">
        <section
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-sm"
          aria-label={t('wikirag.page.chatAria')}
        >
          <div className="min-h-0 flex-1">
            <WikiRagChat
              onOpenDocument={(id) => setModalDocId(id)}
              onOpenKnowledge={() => setKnowledgeOpen(true)}
              knowledgeCount={indexStats.total}
            />
          </div>
        </section>
      </div>

      {knowledgeOpen
        ? createPortal(
            <div
              className="app-modal-layer wikirag-modal-backdrop fixed inset-0 z-[200] flex justify-end bg-slate-950/40 backdrop-blur-[2px]"
              role="dialog"
              aria-modal
              aria-label={t('wikirag.library.title')}
              onClick={() => setKnowledgeOpen(false)}
            >
        <aside
          className="wikirag-drawer flex h-full w-full max-w-[min(92rem,98vw)] min-w-0 flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
          aria-label={t('wikirag.library.title')}
          onClick={(event) => event.stopPropagation()}
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.library.title')}</h2>
            </div>
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
              <span className="rounded-md bg-[var(--color-bg-muted)] px-2 py-1 text-[10px] font-semibold tabular-nums text-[var(--color-fg-muted)]">
                {indexStats.total}
              </span>
              {indexStats.ready > 0 ? (
                <span className="rounded-md bg-[var(--color-success-bg)] px-2 py-1 text-[10px] font-semibold tabular-nums text-[var(--color-success-fg)]">
                  {indexStats.ready}
                </span>
              ) : null}
              {indexStats.pending > 0 ? (
                <span className="rounded-md bg-blue-500/10 px-2 py-1 text-[10px] font-semibold tabular-nums text-blue-800 dark:text-blue-200">
                  {indexStats.pending}
                </span>
              ) : null}
              {indexStats.error > 0 ? (
                <span className="rounded-md bg-red-500/10 px-2 py-1 text-[10px] font-semibold tabular-nums text-red-700 dark:text-red-300">
                  {indexStats.error}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setKnowledgeOpen(false)}
              className="shrink-0 rounded-lg border border-[var(--color-border)] p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
              aria-label={t('common.close')}
            >
              <IconClose className="h-4 w-4" />
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {showIndexBanner ? (
            <div
              className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-primary-muted)] px-4 py-2"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold text-[var(--color-fg)]">
                  {t('wikirag.documents.reindexProgressTitle')}
                </p>
                <span className="text-[11px] font-bold tabular-nums">{indexProgressPct}%</span>
              </div>
              <div className="wikirag-index-track mt-1.5">
                <div className="wikirag-index-bar" style={{ width: `${indexProgressPct}%` }} />
              </div>
            </div>
          ) : null}

          {canManage ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
              <label
                className="inline-flex min-w-0 max-w-xs items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-fg)]"
                title={t('wikirag.library.embedModelHint')}
              >
                <span className="shrink-0 text-[var(--color-fg-muted)]">{t('wikirag.library.embedModel')}</span>
                <select
                  className="min-w-0 flex-1 truncate border-0 bg-transparent py-0.5 text-[11px] font-medium outline-none"
                  value={embedModel}
                  onChange={(e) => void onChangeEmbedModel(e.target.value)}
                >
                  {!embedSelectOptions.length ? (
                    <option value={embedModel}>{embedModel}</option>
                  ) : (
                    embedSelectOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <label
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-fg)]"
                title={t('wikirag.library.autoIndexHint')}
              >
                <input
                  type="checkbox"
                  className="rounded border-[var(--color-border)] text-[var(--color-primary)]"
                  checked={autoIndex}
                  onChange={(e) => void onToggleAutoIndex(e.target.checked)}
                />
                <span>{t('wikirag.library.autoIndex')}</span>
              </label>
              {needIndex > 0 ? (
                <button
                  type="button"
                  disabled={reindexingAll || indexJobActive}
                  onClick={() => void onReindexPending()}
                  className="rounded-md bg-[var(--color-primary)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-70"
                >
                  {reindexingAll || indexJobActive
                    ? t('wikirag.documents.reindexBusy')
                    : t('wikirag.documents.reindexPending', { n: needIndex })}
                </button>
              ) : null}
              {rows.length > 0 ? (
                <button
                  type="button"
                  disabled={reindexingAll || indexJobActive}
                  title={t('wikirag.documents.reindexAllHint')}
                  onClick={() => void onReindexAll()}
                  className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-70"
                >
                  {t('wikirag.documents.reindexAll')}
                </button>
              ) : null}
            </div>
          ) : null}

          <div className="min-h-0 flex-1 overflow-hidden p-3">
      <WikiRagLibrary
        rows={rows}
        folders={folders}
        currentPath={currentPath}
        onPathChange={setCurrentPath}
        canManage={canManage}
        loading={loading}
        modalDocId={modalDocId}
        onOpenDoc={(id) => setModalDocId(id)}
        onReload={() => void load()}
        fillHeight
      />
          </div>

          <div className="max-h-[42vh] shrink-0 overflow-y-auto border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <button
            type="button"
            onClick={() => setUploadPanelOpen((open) => !open)}
            className="flex w-full items-center justify-between rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-left"
            aria-expanded={uploadPanelOpen}
          >
            <span>
              <span className="block text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.sources.title')}</span>
              <span className="mt-0.5 block text-xs text-[var(--color-fg-muted)]">{t('wikirag.sources.subtitle')}</span>
            </span>
            <span className={`text-sm text-[var(--color-fg-muted)] transition ${uploadPanelOpen ? 'rotate-180' : ''}`}>
              ▾
            </span>
          </button>

      {uploadPanelOpen && canManage ? (
        <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3.5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            {currentPath ? (
              <p className="min-w-0 truncate text-[11px] font-medium text-[var(--color-primary)]">
                {t('wikirag.library.uploadInto', { path: currentPath })}
              </p>
            ) : <span />}
            <button
              type="button"
              disabled={importingCorax}
              onClick={() => void onImportCorax()}
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            >
              {importingCorax ? t('wikirag.import.busy') : t('wikirag.import.button')}
            </button>
          </div>

          <form
            className="grid gap-3"
            onSubmit={(e) => void onUpload(e)}
          >
            <div>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="sr-only"
                disabled={uploading}
                onChange={(e) => pickFiles(e.target.files)}
              />
              <input
                ref={(el) => {
                  folderRef.current = el
                  if (el) {
                    el.setAttribute('webkitdirectory', '')
                    el.setAttribute('directory', '')
                  }
                }}
                type="file"
                multiple
                className="sr-only"
                disabled={uploading}
                onChange={(e) => pickFiles(e.target.files)}
              />
              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    fileRef.current?.click()
                  }
                }}
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={`wikirag-dropzone relative flex min-h-[7.5rem] flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed px-4 py-4 text-center transition ${
                  dragOver
                    ? 'wikirag-dropzone--hot border-[var(--color-primary)] bg-[var(--color-primary-muted)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-primary)_40%,transparent)]'
                    : selectedFiles.length || uploading
                      ? 'border-[var(--color-primary)]/40 bg-[var(--color-primary-muted)]/40'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]'
                } ${readingDrop ? 'pointer-events-none opacity-60' : ''} ${uploading ? 'pointer-events-none' : ''}`}
              >
                {uploading && uploadProgress ? (
                  <div className="wikirag-upload-live relative z-[1] w-full max-w-md px-1">
                    <div className="mb-2 flex items-center justify-center gap-2">
                      <span className="wikirag-index-spinner" aria-hidden />
                      <p className="text-sm font-semibold text-[var(--color-primary)]">
                        {uploadProgress.phase === 'folders'
                          ? t('wikirag.upload.phaseFolders', {
                              done: uploadProgress.folderDone ?? 0,
                              total: uploadProgress.folderTotal ?? 0,
                            })
                          : t('wikirag.upload.busy', {
                              done: uploadProgress.done,
                              total: uploadProgress.total,
                            })}
                      </p>
                    </div>
                    <p className="mb-2 text-[11px] text-[var(--color-fg-muted)]">
                      {t('wikirag.upload.parallelHint', { n: UPLOAD_CONCURRENCY })}
                    </p>
                    <div className="wikirag-index-track">
                      <div
                        className="wikirag-index-bar"
                        style={{
                          width: `${
                            uploadProgress.phase === 'folders'
                              ? Math.round(
                                  ((uploadProgress.folderDone ?? 0) /
                                    Math.max(uploadProgress.folderTotal ?? 1, 1)) *
                                    100,
                                )
                              : Math.round(
                                  (uploadProgress.done / Math.max(uploadProgress.total, 1)) * 100,
                                )
                          }%`,
                        }}
                      />
                      <div className="wikirag-index-shimmer" aria-hidden />
                    </div>
                  </div>
                ) : readingDrop ? (
                  <p className="text-sm font-semibold text-[var(--color-primary)]">{t('wikirag.upload.readingFolder')}</p>
                ) : dragOver ? (
                  <p className="wikirag-dropzone-pulse text-sm font-semibold text-[var(--color-primary)]">
                    {t('wikirag.upload.dropFile')}
                  </p>
                ) : selectedFiles.length ? (
                  <>
                    <p className="text-sm font-semibold text-[var(--color-fg)]">
                      {(() => {
                        const root = folderRootName(selectedFiles)
                        const bytes = formatBytes(
                          selectedFiles.reduce((s, f) => s + f.size, 0),
                          t,
                        )
                        if (root && selectedFiles.length > 1) {
                          return t('wikirag.upload.selectedFolder', { name: root, n: selectedFiles.length })
                        }
                        if (selectedFiles.length === 1) {
                          return t('wikirag.upload.selectedOne', { name: relativePathOf(selectedFiles[0]) })
                        }
                        return t('wikirag.upload.selectedMany', { n: selectedFiles.length, bytes })
                      })()}
                    </p>
                    {selectedFiles.length === 1 ? (
                      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{formatBytes(selectedFiles[0].size, t)}</p>
                    ) : (
                      <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
                        {formatBytes(
                          selectedFiles.reduce((s, f) => s + f.size, 0),
                          t,
                        )}
                      </p>
                    )}
                    {skippedCount > 0 ? (
                      <p className="mt-1 text-[11px] text-yellow-800 dark:text-yellow-200">
                        {t('wikirag.upload.skipHint', { n: skippedCount })}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <IconFolder className="mb-2 h-8 w-8 text-[var(--color-fg-subtle)] transition-transform duration-300 group-hover:scale-105" />
                    <p className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.upload.dragHere')}</p>
                    <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('wikirag.upload.clickToChoose')}</p>
                  </>
                )}
                {!uploading ? (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={(e) => {
                      e.stopPropagation()
                      fileRef.current?.click()
                    }}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                  >
                    {t('wikirag.upload.chooseFile')}
                  </button>
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={(e) => {
                      e.stopPropagation()
                      folderRef.current?.click()
                    }}
                    className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
                  >
                    {t('wikirag.upload.chooseFolder')}
                  </button>
                  {selectedFiles.length ? (
                    <button
                      type="button"
                      disabled={uploading}
                      onClick={(e) => {
                        e.stopPropagation()
                        clearSelectedFiles()
                      }}
                      className="rounded-md px-2.5 py-1 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                    >
                      {t('wikirag.upload.chooseAnother')}
                    </button>
                  ) : null}
                </div>
                ) : null}
              </div>
            </div>

            <div>
              <label
                className="mb-1.5 block text-xs font-medium text-[var(--color-fg-subtle)]"
                htmlFor="wikirag-upload-comment"
              >
                {t('wikirag.upload.comment')}
              </label>
              <textarea
                id="wikirag-upload-comment"
                value={uploadComment}
                onChange={(e) => setUploadComment(e.target.value)}
                rows={2}
                placeholder={t('wikirag.upload.commentPlaceholder')}
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={uploading || !selectedFiles.length}
              className="self-end rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {uploading && uploadProgress
                ? uploadProgress.phase === 'folders'
                  ? t('wikirag.upload.phaseFoldersShort')
                  : t('wikirag.upload.busy', { done: uploadProgress.done, total: uploadProgress.total })
                : uploading
                  ? t('wikirag.upload.busySimple')
                  : t('wikirag.upload.button')}
            </button>
          </form>

          {coraxSnapshot ? (
            <p className="mt-3 text-xs text-[var(--color-fg-muted)]">
              CORAX: {coraxSnapshot.files ?? coraxSnapshot.documents?.length ?? 0} · {coraxSnapshot.computers} ПК ·{' '}
              {coraxSnapshot.requests} заявок · {coraxSnapshot.tags} тегов
            </p>
          ) : (
            <p className="mt-3 text-xs text-[var(--color-fg-subtle)]">{t('wikirag.import.description')}</p>
          )}
        </section>
      ) : !canManage ? (
        <p className="text-sm text-[var(--color-fg-muted)]">{t('wikirag.upload.restricted')}</p>
      ) : null}
          </div>
          </div>
        </aside>
            </div>,
            document.body,
          )
        : null}

      {modalDoc
        ? createPortal(
            <div
              className="app-modal-layer wikirag-modal-backdrop fixed inset-0 z-[210] flex items-stretch justify-center bg-slate-900/45 p-0 backdrop-blur-sm sm:items-center sm:p-4"
              role="dialog"
              aria-modal
              onClick={() => setModalDocId(null)}
            >
          <div
            className="wikirag-modal-panel flex max-h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 bg-[var(--color-surface)] p-0 sm:max-h-[min(92vh,900px)] sm:max-w-[min(56rem,calc(100vw-2rem))] sm:rounded-xl sm:border sm:border-[var(--color-border)] sm:shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
              <h2 className="truncate text-base font-semibold text-[var(--color-fg)]">{modalDoc.original_filename}</h2>
              <button
                type="button"
                onClick={() => setModalDocId(null)}
                className="shrink-0 rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
                aria-label={t('wikirag.page.closeViewer')}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <WikiRagDocViewer doc={modalDoc} canManage={canManage} embedded onSaved={() => void load()} />
            </div>
          </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
