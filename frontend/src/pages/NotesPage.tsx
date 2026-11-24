import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, type NoteColor, type NoteListItem, type NoteMark, type NoteRow, type User } from '../api'
import { useAuth } from '../AuthContext'
import { NotesCalendarPanel } from '../components/notes/NotesCalendarPanel'
import { IconBook, IconClose, IconPencil, IconTrash } from '../components/icons'
import { useConfirmDialog } from '../components/ConfirmDialog'
import { useT } from '../i18n/LocaleContext'
import { peekCache, putCache } from '../lib/viewCache'
import { NOTES_LIST_KEY } from '../tabWarm'
import { useToast } from '../ToastContext'
import { formatNoteSelection, readNoteEditorHtml, sanitizeNoteHtml, type NoteFormat } from '../lib/notesHtml'
import { formatNotePlanRange } from '../lib/notesPlan'

const NOTE_COLORS: NoteColor[] = ['blue', 'green', 'amber', 'rose', 'violet', 'slate']
const NOTE_MARKS: NoteMark[] = ['dot', 'flag', 'star']

const COLOR_SWATCH: Record<NoteColor, string> = {
  blue: 'bg-sky-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
  slate: 'bg-slate-500',
}

const MARK_GLYPH: Record<NoteMark, string> = {
  dot: '●',
  flag: '⚑',
  star: '★',
}

const NoteBodyEditor = memo(function NoteBodyEditor({
  noteId,
  canEdit,
  initialHtml,
  onHtmlChange,
}: {
  noteId: number
  canEdit: boolean
  initialHtml: string
  onHtmlChange: (html: string, source: 'edit' | 'blur' | 'unmount') => void
}) {
  const elRef = useRef<HTMLDivElement>(null)
  const onHtmlChangeRef = useRef(onHtmlChange)
  onHtmlChangeRef.current = onHtmlChange
  const initialRef = useRef(initialHtml)
  initialRef.current = initialHtml

  useEffect(() => {
    const el = elRef.current
    if (el) el.innerHTML = sanitizeNoteHtml(initialRef.current || '')
    return () => {
      onHtmlChangeRef.current(elRef.current?.innerHTML ?? '', 'unmount')
    }
  }, [noteId])

  return (
    <div
      ref={elRef}
      data-note-id={noteId}
      className="notes-editor min-h-[12rem] flex-1 px-3.5 py-3 text-[14px] leading-relaxed text-[var(--color-fg)] outline-none [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6"
      contentEditable={canEdit}
      suppressContentEditableWarning
      onInput={() => onHtmlChangeRef.current(elRef.current?.innerHTML ?? '', 'edit')}
      onBlur={() => onHtmlChangeRef.current(elRef.current?.innerHTML ?? '', 'blur')}
    />
  )
})

export function NotesPage() {
  const t = useT()
  const { ask, dialog: confirmDialog } = useConfirmDialog()
  const toast = useToast()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = Number(searchParams.get('id') || 0) || null

  const cachedNotes = peekCache<NoteListItem[]>(NOTES_LIST_KEY)
  const [list, setList] = useState<NoteListItem[]>(cachedNotes ?? [])
  const [query, setQuery] = useState('')
  const [panelUsers, setPanelUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(!cachedNotes)
  const [note, setNote] = useState<NoteRow | null>(null)
  const [title, setTitle] = useState('')
  const [planStart, setPlanStart] = useState('')
  const [planEnd, setPlanEnd] = useState('')
  const [sameDayEnd, setSameDayEnd] = useState(false)
  const [color, setColor] = useState<NoteColor | null>(null)
  const [mark, setMark] = useState<NoteMark | null>(null)
  const [shareDraft, setShareDraft] = useState<{ user_id: number; can_edit: boolean }[]>([])
  const [saving, setSaving] = useState(false)
  const [saveLabel, setSaveLabel] = useState<string | null>(null)
  const saveTimer = useRef<number | null>(null)
  const persistInFlight = useRef<Promise<void> | null>(null)
  const titleRef = useRef(title)
  const planStartRef = useRef(planStart)
  const planEndRef = useRef(planEnd)
  const colorRef = useRef(color)
  const markRef = useRef(mark)
  const noteRef = useRef(note)
  const bodyHtmlRef = useRef('')
  const persistNowRef = useRef<(opts?: { keepalive?: boolean }) => Promise<void>>(async () => {})

  titleRef.current = title
  planStartRef.current = planStart
  planEndRef.current = planEnd
  colorRef.current = color
  markRef.current = mark
  noteRef.current = note

  const reloadList = useCallback(async () => {
    const items = await api.notes()
    putCache(NOTES_LIST_KEY, items)
    setList(items)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (!peekCache<NoteListItem[]>(NOTES_LIST_KEY)) setLoading(true)
      try {
        const [items, users] = await Promise.all([api.notes(), api.users()])
        if (cancelled) return
        putCache(NOTES_LIST_KEY, items)
        setList(items)
        setPanelUsers(users.filter((u) => !u.is_ldap && u.role !== 'directory' && u.is_active))
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : t('notes.loadFailed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [t, toast])

  const persistNow = useCallback(async (opts?: { keepalive?: boolean }) => {
    const row = noteRef.current
    if (!row?.can_edit) return
    const id = row.id
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const live = readNoteEditorHtml(id)
    if (live != null) bodyHtmlRef.current = live
    const body_html = sanitizeNoteHtml(bodyHtmlRef.current)
    const payload = {
      title: titleRef.current,
      body_html,
      plan_start: planStartRef.current || null,
      plan_end: planEndRef.current || null,
      color: colorRef.current,
      mark: markRef.current,
    }
    const keepalive =
      Boolean(opts?.keepalive) && new Blob([JSON.stringify(payload)]).size < 60_000
    if (persistInFlight.current) await persistInFlight.current
    if (!opts?.keepalive) setSaving(true)
    const run = (async () => {
      try {
        const updated = await api.updateNote(id, payload, keepalive ? { keepalive: true } : undefined)
        if (opts?.keepalive) return
        if (noteRef.current?.id === id) {
          setNote((prev) =>
            prev && prev.id === id
              ? {
                  ...prev,
                  title: updated.title,
                  plan_start: updated.plan_start,
                  plan_end: updated.plan_end,
                  color: updated.color,
                  mark: updated.mark,
                  updated_at: updated.updated_at,
                }
              : prev,
          )
          setSaveLabel(t('notes.saved'))
        }
        await reloadList()
      } catch (e) {
        if (!opts?.keepalive) toast.error(e instanceof Error ? e.message : t('notes.saveFailed'))
      } finally {
        if (!opts?.keepalive) {
          setSaving(false)
          window.setTimeout(() => setSaveLabel(null), 2000)
        }
      }
    })()
    persistInFlight.current = run
    await persistInFlight.current
    persistInFlight.current = null
  }, [reloadList, t, toast])

  persistNowRef.current = persistNow

  /** Debounced save; reads latest title/dates/body from refs so onChange does not race setState. */
  const scheduleSave = useCallback(() => {
    if (!noteRef.current?.can_edit) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void persistNowRef.current()
    }, 600)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (noteRef.current?.can_edit) {
        await persistNowRef.current()
      }
      if (cancelled) return
      if (!selectedId) {
        setNote(null)
        return
      }
      try {
        const row = await api.note(selectedId)
        if (cancelled) return
        setNote(row)
        setTitle(row.title)
        const start = row.plan_start ? row.plan_start.slice(0, 10) : ''
        const end = row.plan_end ? row.plan_end.slice(0, 10) : ''
        setPlanStart(start)
        setPlanEnd(end)
        setSameDayEnd(Boolean(start && end && start === end))
        setColor(row.color ?? null)
        setMark(row.mark ?? null)
        setShareDraft(row.shares.map((s) => ({ user_id: s.user_id, can_edit: s.can_edit })))
        bodyHtmlRef.current = row.body_html || ''
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : t('notes.loadFailed'))
          setSearchParams({})
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, setSearchParams, t, toast])

  const canEdit = Boolean(note?.can_edit)
  const isOwner = Boolean(note?.is_owner)

  useEffect(() => {
    const flush = () => {
      void persistNowRef.current({ keepalive: true })
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [])

  const shareCandidates = useMemo(() => {
    if (!note || !user) return panelUsers
    return panelUsers.filter((u) => u.id !== note.owner_user_id)
  }, [note, panelUsers, user])

  const createNote = async () => {
    try {
      const today = new Date().toISOString().slice(0, 10)
      const row = await api.createNote({
        title: t('notes.untitled'),
        body_html: '<p><br></p>',
        plan_start: today,
        plan_end: null,
      })
      await reloadList()
      setSearchParams({ id: String(row.id) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notes.saveFailed'))
    }
  }

  const removeNote = async () => {
    if (!note || !isOwner) return
    if (
      !(await ask({
        title: t('common.delete'),
        body: t('notes.deleteConfirm'),
        confirmLabel: t('common.delete'),
        tone: 'danger',
      }))
    )
      return
    try {
      await api.deleteNote(note.id)
      setNote(null)
      setSearchParams({})
      await reloadList()
      toast.ok(t('notes.deleted'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notes.saveFailed'))
    }
  }

  const saveShares = async () => {
    if (!note || !isOwner) return
    try {
      const updated = await api.replaceNoteShares(note.id, shareDraft)
      setNote(updated)
      toast.ok(t('notes.sharesSaved'))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notes.saveFailed'))
    }
  }

  const toggleShare = (userId: number) => {
    setShareDraft((prev) => {
      const exists = prev.find((x) => x.user_id === userId)
      if (exists) return prev.filter((x) => x.user_id !== userId)
      return [...prev, { user_id: userId, can_edit: false }]
    })
  }

  const setShareEdit = (userId: number, can_edit: boolean) => {
    setShareDraft((prev) => prev.map((x) => (x.user_id === userId ? { ...x, can_edit } : x)))
  }

  const allShared =
    shareCandidates.length > 0 &&
    shareCandidates.every((u) => shareDraft.some((s) => s.user_id === u.id))

  const toggleShareAll = () => {
    if (allShared) {
      setShareDraft([])
      return
    }
    setShareDraft((prev) =>
      shareCandidates.map((u) => {
        const existing = prev.find((x) => x.user_id === u.id)
        return existing ?? { user_id: u.id, can_edit: false }
      }),
    )
  }

  const applyPlanStart = (value: string) => {
    setPlanStart(value)
    planStartRef.current = value
    if (sameDayEnd) {
      setPlanEnd(value)
      planEndRef.current = value
    }
    scheduleSave()
  }

  const applyPlanEnd = (value: string) => {
    setPlanEnd(value)
    planEndRef.current = value
    setSameDayEnd(Boolean(value && value === planStartRef.current))
    scheduleSave()
  }

  const applyColor = (next: NoteColor | null) => {
    setColor(next)
    colorRef.current = next
    void persistNowRef.current()
  }

  const applyMark = (next: NoteMark | null) => {
    setMark(next)
    markRef.current = next
    void persistNowRef.current()
  }

  const toggleSameDayEnd = (checked: boolean) => {
    setSameDayEnd(checked)
    if (checked) {
      const start = planStartRef.current
      setPlanEnd(start)
      planEndRef.current = start
    }
    scheduleSave()
  }

  const formatPlan = (item: NoteListItem) => formatNotePlanRange(item.plan_start, item.plan_end)
  const visibleList = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return list
    return list.filter((item) => {
      const hay = `${item.title} ${item.owner_username || ''} ${formatNotePlanRange(item.plan_start, item.plan_end)}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [list, query])

  function applyFormat(kind: NoteFormat) {
    const el = document.querySelector('.notes-editor')
    if (!(el instanceof HTMLElement)) return
    if (!formatNoteSelection(el, kind)) return
    bodyHtmlRef.current = el.innerHTML
    void persistNowRef.current()
  }

  return (
    <div>
      <h1 className="sr-only">{t('notes.title')}</h1>
      <div className="notes-workspace">
        <aside className="app-panel notes-workspace__aside !p-2.5">
          <button
            type="button"
            onClick={() => void createNote()}
            className="app-btn app-btn-primary mb-2 w-full !min-h-9 !py-1.5 text-sm"
          >
            {t('notes.create')}
          </button>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('notes.searchPlaceholder')}
            className="app-input mb-2 !min-h-0 !py-1.5 text-sm"
            aria-label={t('notes.list')}
          />
          {query.trim() && list.length > 0 ? (
            <div className="mb-1.5 px-0.5 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
              {t('notes.searchCount', { n: visibleList.length, total: list.length })}
            </div>
          ) : null}
          {loading ? (
            <div className="space-y-1.5 px-0.5 py-1" role="status" aria-busy="true">
              <span className="sr-only">{t('common.loading')}</span>
              <div className="h-8 animate-pulse rounded-md bg-[var(--color-bg-muted)]" />
              <div className="h-8 animate-pulse rounded-md bg-[var(--color-bg-muted)]" />
              <div className="h-8 animate-pulse rounded-md bg-[var(--color-bg-muted)]" />
            </div>
          ) : list.length === 0 ? (
            <p className="app-empty-state !rounded-md !border-dashed !px-2.5 !py-3 text-xs">{t('notes.empty')}</p>
          ) : visibleList.length === 0 ? (
            <p className="px-1 py-2 text-xs text-[var(--color-fg-subtle)]">{t('notes.searchEmpty')}</p>
          ) : (
            <ul className="notes-workspace__list space-y-0.5 overflow-y-auto">
              {visibleList.map((item) => {
                const active = item.id === selectedId
                const plan = formatPlan(item)
                const meta = [item.is_shared_with_me ? t('notes.sharedBadge') : null, plan]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSearchParams({ id: String(item.id) })}
                      className={`notes-workspace__item${active ? ' is-active' : ''}`}
                    >
                      <span className="notes-workspace__item-title">
                        {item.mark ? `${MARK_GLYPH[item.mark]} ` : ''}
                        {item.color ? (
                          <span
                            className={`mr-1.5 inline-block h-1.5 w-1.5 translate-y-[-1px] rounded-full ${COLOR_SWATCH[item.color]}`}
                            aria-hidden
                          />
                        ) : null}
                        {item.title || t('notes.untitled')}
                      </span>
                      {meta ? <span className="notes-workspace__item-meta">{meta}</span> : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        <div className="app-panel notes-workspace__cal !p-0 overflow-hidden">
          <NotesCalendarPanel
            notes={list}
            onSelectNote={(id) => setSearchParams({ id: String(id) })}
          />
        </div>

        <section className="app-panel notes-workspace__main !p-0 overflow-hidden">
          {!note ? (
            <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 px-6 text-center">
              <IconBook className="h-8 w-8 text-[var(--color-fg-subtle)]" />
              <p className="max-w-sm text-sm text-[var(--color-fg-muted)]">{t('notes.pickOrCreate')}</p>
            </div>
          ) : (
            <div className="notes-workspace__editor flex min-h-0 flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-3 py-2.5">
                <input
                  className="app-input !min-h-0 min-w-0 flex-1 !border-0 !bg-transparent !px-0 !text-base !font-semibold !shadow-none"
                  value={title}
                  disabled={!canEdit}
                  onChange={(e) => {
                    const v = e.target.value
                    setTitle(v)
                    titleRef.current = v
                    scheduleSave()
                  }}
                  placeholder={t('notes.titlePlaceholder')}
                />
                <span className="text-[11px] text-[var(--color-fg-subtle)]">
                  {saving ? t('notes.saving') : saveLabel}
                </span>
                {isOwner ? (
                  <button
                    type="button"
                    className="app-btn app-btn-secondary !min-h-8 !w-8 !px-0 !py-0"
                    onClick={() => void removeNote()}
                    title={t('notes.delete')}
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="app-btn app-btn-secondary !min-h-8 !w-8 !px-0 !py-0 xl:hidden"
                  onClick={() => {
                    setNote(null)
                    setSearchParams({})
                    navigate('/knowledge-base/notes')
                  }}
                >
                  <IconClose className="h-4 w-4" />
                </button>
              </div>

              {canEdit ? (
                <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--color-border)] px-2.5 py-1">
                  {(
                    [
                      ['bold', t('notes.fmtBold'), 'bold'],
                      ['italic', t('notes.fmtItalic'), 'italic'],
                      ['ul', t('notes.fmtList'), 'ul'],
                      ['h', t('notes.fmtHeading'), 'h2'],
                      ['p', t('notes.fmtParagraph'), 'p'],
                    ] as const
                  ).map(([key, label, kind]) => (
                    <button
                      key={key}
                      type="button"
                      className="app-chip !min-h-0 !rounded-md !px-2 !py-1 text-[11px]"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        applyFormat(kind)
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="border-b border-[var(--color-border)] px-3 py-1.5 text-[11px] text-[var(--color-fg-subtle)]">
                  {t('notes.readOnly')}
                </div>
              )}

              <NoteBodyEditor
                key={note.id}
                noteId={note.id}
                canEdit={canEdit}
                initialHtml={note.body_html || ''}
                onHtmlChange={(html, source) => {
                  if (source === 'unmount') {
                    if (html) bodyHtmlRef.current = html
                    return
                  }
                  bodyHtmlRef.current = html
                  if (!canEdit) return
                  if (source === 'edit') scheduleSave()
                  if (source === 'blur') void persistNowRef.current()
                }}
              />

              <div className="notes-workspace__meta grid gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/30 p-3 lg:grid-cols-2">
                <div>
                  <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--color-fg-subtle)]">
                    <IconPencil className="h-3.5 w-3.5" />
                    {t('notes.planDates')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="text-xs text-[var(--color-fg-muted)]">
                      {t('notes.planStart')}
                      <input
                        type="date"
                        className="app-input mt-1 !min-h-8 !py-1 !text-sm"
                        value={planStart}
                        disabled={!canEdit}
                        onChange={(e) => applyPlanStart(e.target.value)}
                      />
                    </label>
                    <label className="text-xs text-[var(--color-fg-muted)]">
                      {t('notes.planEnd')}
                      <input
                        type="date"
                        className="app-input mt-1 !min-h-8 !py-1 !text-sm"
                        value={planEnd}
                        disabled={!canEdit || sameDayEnd}
                        onChange={(e) => applyPlanEnd(e.target.value)}
                      />
                    </label>
                  </div>
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-xs text-[var(--color-fg-muted)]">
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5"
                      checked={sameDayEnd}
                      disabled={!canEdit || !planStart}
                      onChange={(e) => toggleSameDayEnd(e.target.checked)}
                    />
                    <span>{t('notes.sameDayEnd')}</span>
                  </label>

                  <div className="mt-2.5">
                    <div className="mb-1 text-[12px] font-semibold text-[var(--color-fg-subtle)]">
                      {t('notes.planColor')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => applyColor(null)}
                        className={`app-chip !min-h-0 !px-2 !py-1 text-[10px]${
                          color == null ? ' app-chip--active' : ''
                        }`}
                      >
                        {t('notes.planColorNone')}
                      </button>
                      {NOTE_COLORS.map((token) => (
                        <button
                          key={token}
                          type="button"
                          disabled={!canEdit}
                          title={t(`notes.colors.${token}`)}
                          onClick={() => applyColor(token)}
                          className={`h-5 w-5 rounded-full ${COLOR_SWATCH[token]} ${
                            color === token ? 'ring-2 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-surface)]' : ''
                          }`}
                          aria-label={t(`notes.colors.${token}`)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="mt-2.5">
                    <div className="mb-1 text-[12px] font-semibold text-[var(--color-fg-subtle)]">
                      {t('notes.planMark')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => applyMark(null)}
                        className={`app-chip !min-h-0 !px-2 !py-1 text-[10px]${
                          mark == null ? ' app-chip--active' : ''
                        }`}
                      >
                        {t('notes.planMarkNone')}
                      </button>
                      {NOTE_MARKS.map((token) => (
                        <button
                          key={token}
                          type="button"
                          disabled={!canEdit}
                          title={t(`dashboard.calendar.marks.${token}`)}
                          onClick={() => applyMark(token)}
                          className={`app-chip !min-h-0 !min-w-7 !justify-center !px-1.5 !py-1 text-sm${
                            mark === token ? ' app-chip--active' : ''
                          }`}
                          aria-label={t(`dashboard.calendar.marks.${token}`)}
                        >
                          {MARK_GLYPH[token]}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {isOwner ? (
                  <div>
                    <div className="mb-1.5 text-[12px] font-semibold text-[var(--color-fg-subtle)]">
                      {t('notes.access')}
                    </div>
                    <p className="mb-1.5 text-[11px] text-[var(--color-fg-subtle)]">{t('notes.accessHint')}</p>
                    <div className="max-h-36 space-y-0.5 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1.5">
                      {shareCandidates.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-[var(--color-fg-subtle)]">{t('notes.noUsers')}</p>
                      ) : (
                        <>
                          <div className="mb-0.5 flex items-center gap-2 border-b border-[var(--color-border)] px-1.5 pb-1.5">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={allShared}
                              onChange={toggleShareAll}
                            />
                            <span className="min-w-0 flex-1 text-xs font-semibold text-[var(--color-fg)]">
                              {t('notes.shareEveryone')}
                            </span>
                          </div>
                          {shareCandidates.map((u) => {
                            const row = shareDraft.find((x) => x.user_id === u.id)
                            return (
                              <div key={u.id} className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-[var(--color-surface-muted)]">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5"
                                  checked={Boolean(row)}
                                  onChange={() => toggleShare(u.id)}
                                />
                                <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-fg)]">
                                  {u.full_name || u.username}
                                  <span className="text-[var(--color-fg-subtle)]"> · {u.username}</span>
                                </span>
                                {row ? (
                                  <label className="flex shrink-0 items-center gap-1 text-[10px] text-[var(--color-fg-muted)]">
                                    <input
                                      type="checkbox"
                                      className="h-3 w-3"
                                      checked={row.can_edit}
                                      onChange={(e) => setShareEdit(u.id, e.target.checked)}
                                    />
                                    {t('notes.canEdit')}
                                  </label>
                                ) : null}
                              </div>
                            )
                          })}
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className="app-btn app-btn-secondary mt-2 !min-h-8 !px-3 !py-1 text-xs"
                      onClick={() => void saveShares()}
                    >
                      {t('notes.saveShares')}
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="mb-1.5 text-[12px] font-semibold text-[var(--color-fg-subtle)]">
                      {t('notes.access')}
                    </div>
                    <p className="text-xs text-[var(--color-fg-muted)]">
                      {t('notes.ownerLabel')}: {note.owner_full_name || note.owner_username}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </section>
      </div>
      {confirmDialog}
    </div>
  )
}
