import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { api, type WikiRagDocumentRow, type WikiRagLmStudioStatus } from '../api'
import { useAuth } from '../AuthContext'
import { WikiRagChat } from '../components/wikirag/WikiRagChat'
import { WikiRagDocViewer } from '../components/wikirag/WikiRagDocViewer'
import { IconBook, IconClose, IconTrash } from '../components/icons'
import { useLocale, useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'

const ACCEPT =
  '.pdf,.txt,.md,.doc,.docx,.xls,.xlsx,.csv,.png,.jpg,.jpeg,.webp,application/pdf,text/plain'

const ALLOWED_EXT = new Set([
  '.pdf', '.txt', '.md', '.doc', '.docx', '.xls', '.xlsx', '.csv', '.png', '.jpg', '.jpeg', '.webp',
])

function fileExtension(name: string) {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i).toLowerCase() : ''
}

function isAllowedFile(file: File) {
  return ALLOWED_EXT.has(fileExtension(file.name))
}

function formatBytes(n: number, t: ReturnType<typeof useT>) {
  if (n < 1024) return t('wikirag.common.bytes', { n })
  if (n < 1024 * 1024) return t('wikirag.common.kb', { n: (n / 1024).toFixed(1) })
  return t('wikirag.common.mb', { n: (n / (1024 * 1024)).toFixed(1) })
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

function DocRow({
  row,
  canManage,
  active,
  onOpen,
  onReload,
}: {
  row: WikiRagDocumentRow
  canManage: boolean
  active: boolean
  onOpen: () => void
  onReload: () => void
}) {
  const t = useT()
  const toast = useToast()
  const { locale } = useLocale()
  const [commentDraft, setCommentDraft] = useState(row.comment ?? '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setCommentDraft(row.comment ?? '')
  }, [row.comment, row.id])

  async function saveComment() {
    const next = commentDraft.trim() || null
    const prev = row.comment?.trim() || null
    if (next === prev) return
    setSaving(true)
    try {
      await api.updateWikiRagDocument(row.id, { comment: next })
      onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    } finally {
      setSaving(false)
    }
  }

  async function onDelete() {
    if (!confirm(t('wikirag.documents.deleteConfirm', { name: row.original_filename }))) return
    try {
      await api.deleteWikiRagDocument(row.id)
      onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wikirag.common.genericError'))
    }
  }

  return (
    <tr className={`border-t border-[var(--color-border)] ${active ? 'bg-blue-50/50' : 'hover:bg-[var(--color-surface-muted)]'}`}>
      <td className="px-3 py-2.5 align-top">
        <button
          type="button"
          onClick={onOpen}
          className="text-left font-medium text-blue-700 underline decoration-blue-200 underline-offset-2 hover:text-blue-800"
        >
          {row.original_filename}
        </button>
        <div className="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">
          {formatBytes(row.size_bytes, t)} · {formatWhen(row.created_at, locale)} · @{row.uploaded_by_username}
        </div>
      </td>
      <td className="hidden px-3 py-2.5 align-top md:table-cell">
        {canManage ? (
          <textarea
            value={commentDraft}
            onChange={(e) => setCommentDraft(e.target.value)}
            rows={2}
            className="w-full min-w-[10rem] resize-y rounded-lg border border-[var(--color-border)] px-2 py-1 text-xs"
            onBlur={() => void saveComment()}
          />
        ) : (
          <span className="text-xs text-[var(--color-fg-muted)]">{row.comment?.trim() || '—'}</span>
        )}
        {saving ? <span className="text-[10px] text-[var(--color-fg-subtle)]">{t('wikirag.documents.savePending')}</span> : null}
      </td>
      {canManage ? (
        <td className="px-3 py-2.5 align-top text-right">
          <button
            type="button"
            onClick={() => void onDelete()}
            className="inline-flex items-center rounded-lg border border-zinc-200 bg-[var(--color-surface)] p-1.5 hover:bg-zinc-50"
            aria-label={t('wikirag.documents.deleteAria')}
          >
            <IconTrash className="h-4 w-4" />
          </button>
        </td>
      ) : null}
    </tr>
  )
}

export function WikiRagPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const [rows, setRows] = useState<WikiRagDocumentRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadComment, setUploadComment] = useState('')
  const [uploading, setUploading] = useState(false)
  const [importingCorax, setImportingCorax] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [modalDocId, setModalDocId] = useState<number | null>(null)
  const [chatOpen, setChatOpen] = useState(true)
  const [lmStatus, setLmStatus] = useState<WikiRagLmStudioStatus | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)

  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')
  const modalDoc = rows.find((r) => r.id === modalDocId) ?? null

  const pickFile = useCallback((file: File | null | undefined) => {
    if (!file) return
    if (!isAllowedFile(file)) {
      toast.error(t('wikirag.common.invalidFileType'))
      return
    }
    setSelectedFile(file)
    if (fileRef.current) {
      const dt = new DataTransfer()
      dt.items.add(file)
      fileRef.current.files = dt.files
    }
  }, [t, toast])

  const clearSelectedFile = useCallback(() => {
    setSelectedFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }, [])

  const load = useCallback(async () => {
    try {
      const list = await api.wikiRagDocuments()
      setRows(list)
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
    let cancelled = false
    void api
      .wikiRagLmStudioStatus()
      .then((st) => {
        if (!cancelled) setLmStatus(st)
      })
      .catch(() => {
        if (!cancelled) setLmStatus({ ok: false, models: [], detail: 'unreachable' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!modalDocId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModalDocId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modalDocId])

  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragDepthRef.current += 1
    setDragOver(true)
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
    if (!uploading) pickFile(e.dataTransfer.files?.[0])
  }

  async function onUpload(e: FormEvent) {
    e.preventDefault()
    const file = selectedFile ?? fileRef.current?.files?.[0]
    if (!file) {
      toast.error(t('wikirag.common.selectFile'))
      return
    }
    setUploading(true)
    try {
      const created = await api.uploadWikiRagDocument(file, uploadComment)
      setUploadComment('')
      clearSelectedFile()
      await load()
      setModalDocId(created.id)
      toast.ok(t('wikirag.common.created'))
    } catch (ex) {
      toast.error(ex instanceof Error ? ex.message : t('wikirag.common.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="relative pb-4 lg:pr-[min(22rem,calc(100vw-2rem))]">
      <div className="mb-6 flex min-w-0 items-start gap-3 sm:gap-4">
        <div className="page-hero-icon mt-0.5 shrink-0">
          <IconBook className="h-6 w-6" />
        </div>
        <div>
          <h1 className="page-title">{t('titles.wikirag')}</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-fg-muted)]">
            {t('pages.wikiragSubtitle')}
          </p>
        </div>
      </div>

      {lmStatus && !lmStatus.ok ? (
        <div
          className="mb-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-100"
          role="status"
        >
          <div className="font-semibold">{t('wikirag.lmOfflineTitle')}</div>
          <p className="mt-1 text-[13px] leading-relaxed opacity-90">{t('wikirag.lmOfflineBody')}</p>
          {lmStatus.detail ? (
            <p className="mt-1 font-mono text-[11px] opacity-70">
              {t('wikirag.lmOfflineDetail', { detail: String(lmStatus.detail) })}
            </p>
          ) : null}
        </div>
      ) : null}

      {canManage ? (
        <section className="app-card mb-6 p-5 sm:p-6">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.import.title')}</h2>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
            {t('wikirag.import.description')}
          </p>
          <button
            type="button"
            disabled={importingCorax}
            onClick={() => void (async () => {
              setImportingCorax(true)
              try {
                const res = await api.importWikiRagCorax()
                toast.ok(
                  t('wikirag.import.summary', {
                    action: res.created ? t('wikirag.common.created') : t('wikirag.common.updated'),
                    files: res.files ?? res.documents?.length ?? 1,
                    computers: res.computers,
                    requests: res.requests,
                    tags: res.tags,
                  }),
                )
                await load()
                setModalDocId(res.document.id)
              } catch (ex) {
                const msg = ex instanceof Error ? ex.message : t('wikirag.common.importFailed')
                toast.error(
                  msg === 'Method Not Allowed'
                    ? t('wikirag.common.importMethodNotAllowed')
                    : msg,
                )
              } finally {
                setImportingCorax(false)
              }
            })()}
            className="mt-4 rounded-xl bg-neutral-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-50"
          >
            {importingCorax ? t('wikirag.import.busy') : t('wikirag.import.button')}
          </button>
        </section>
      ) : null}

      {/* Загрузка — крупная карточка */}
      <section className="app-card mb-6 p-5 sm:p-6">
        <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.upload.title')}</h2>
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t('wikirag.upload.subtitle')}</p>
        {!canManage ? (
          <p className="mt-4 text-sm text-[var(--color-fg-muted)]">{t('wikirag.upload.restricted')}</p>
        ) : (
          <form className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]" onSubmit={(e) => void onUpload(e)}>
            <div>
              <input
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                className="sr-only"
                disabled={uploading}
                onChange={(e) => pickFile(e.target.files?.[0])}
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
                onClick={() => fileRef.current?.click()}
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDrop}
                className={`flex min-h-[11rem] cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-8 text-center transition sm:min-h-[12rem] ${
                  dragOver
                    ? 'border-blue-400 bg-blue-50/80 ring-2 ring-blue-400/25'
                    : selectedFile
                      ? 'border-emerald-300 bg-emerald-50/40'
                      : 'border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 hover:border-blue-200 hover:bg-blue-50/20'
                } ${uploading ? 'pointer-events-none opacity-60' : ''}`}
              >
                {dragOver ? (
                  <p className="text-base font-semibold text-blue-700">{t('wikirag.upload.dropFile')}</p>
                ) : selectedFile ? (
                  <>
                    <p className="text-base font-semibold text-[var(--color-fg)]">{selectedFile.name}</p>
                    <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{formatBytes(selectedFile.size, t)}</p>
                    <button
                      type="button"
                      className="relative z-10 mt-4 text-sm font-medium text-blue-700 underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        clearSelectedFile()
                      }}
                    >
                      {t('wikirag.upload.chooseAnother')}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-base font-semibold text-[var(--color-fg)]">{t('wikirag.upload.dragHere')}</p>
                    <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t('wikirag.upload.clickToChoose')}</p>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                  {t('wikirag.upload.comment')}
                </label>
                <textarea
                  value={uploadComment}
                  onChange={(e) => setUploadComment(e.target.value)}
                  rows={5}
                  placeholder={t('wikirag.upload.commentPlaceholder')}
                  className="w-full resize-y rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-sm shadow-sm outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-500/20"
                />
              </div>
              <button
                type="submit"
                disabled={uploading || !selectedFile}
                className="app-btn app-btn-primary mt-auto !w-full"
              >
                {uploading ? t('wikirag.upload.busy') : t('wikirag.upload.button')}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* Список документов */}
      <section className="app-card overflow-hidden">
        <div className="border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">
            {t('wikirag.documents.title', { count: rows.length })}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{t('wikirag.documents.subtitle')}</p>
        </div>
        {loading ? (
          <p className="p-6 text-sm text-[var(--color-fg-muted)]">{t('common.loading')}</p>
        ) : rows.length === 0 ? (
          <p className="p-10 text-center text-sm text-[var(--color-fg-muted)]">{t('wikirag.documents.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead className="bg-[var(--color-surface-muted)] text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
                <tr>
                  <th className="px-3 py-2.5">{t('wikirag.documents.file')}</th>
                  <th className="hidden px-3 py-2.5 md:table-cell">{t('wikirag.documents.comment')}</th>
                  {canManage ? <th className="w-12 px-3 py-2.5" /> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DocRow
                    key={row.id}
                    row={row}
                    canManage={canManage}
                    active={modalDocId === row.id}
                    onOpen={() => setModalDocId(row.id)}
                    onReload={() => void load()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Плавающий чат справа */}
      {chatOpen ? (
        <aside
          className="fixed bottom-4 right-4 top-[max(5.5rem,env(safe-area-inset-top))] z-30 flex w-[min(21rem,calc(100vw-1.5rem))] flex-col rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 shadow-[0_20px_50px_-12px_rgba(15,23,42,0.35)] backdrop-blur-xl sm:p-4"
          aria-label={t('wikirag.page.chatAria')}
        >
          <WikiRagChat
            onClose={() => setChatOpen(false)}
            onOpenDocument={(id) => setModalDocId(id)}
          />
        </aside>
      ) : (
        <button
          type="button"
          onClick={() => setChatOpen(true)}
          className="fixed bottom-6 right-4 z-30 app-btn app-btn-primary !rounded-full !px-4"
        >
          {t('wikirag.page.chatButton')}
        </button>
      )}

      {/* Модальное окно просмотра */}
      {modalDoc ? (
        <div
          className="fixed inset-0 z-50 flex items-stretch justify-center bg-slate-900/45 p-0 backdrop-blur-sm sm:items-center sm:p-4"
          role="dialog"
          aria-modal
          onClick={() => setModalDocId(null)}
        >
          <div
            className="app-card flex max-h-[100dvh] w-full max-w-none flex-col overflow-hidden rounded-none border-0 p-0 sm:max-h-[min(92vh,900px)] sm:max-w-[min(56rem,calc(100vw-2rem))] sm:rounded-2xl sm:border sm:shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
              <h2 className="truncate text-base font-semibold text-[var(--color-fg)]">{modalDoc.original_filename}</h2>
              <button
                type="button"
                onClick={() => setModalDocId(null)}
                className="shrink-0 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[var(--color-fg-muted)] hover:bg-blue-50 hover:text-blue-700"
                aria-label={t('wikirag.page.closeViewer')}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              <WikiRagDocViewer
                doc={modalDoc}
                canManage={canManage}
                embedded
                onSaved={() => void load()}
              />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
