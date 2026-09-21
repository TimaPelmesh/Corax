import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, type NoteColor, type NoteListItem, type NoteMark, type NoteRow, type User } from '../api'
import { useAuth } from '../AuthContext'
import { DashboardCalendar } from '../components/dashboard/DashboardCalendar'
import { IconBook, IconClose, IconPencil, IconTrash } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { readNoteEditorHtml, sanitizeNoteHtml } from '../lib/notesHtml'
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

function focusNoteEditor() {
  const el = document.querySelector('.notes-editor')
  if (el instanceof HTMLElement) el.focus()
}

function execCmd(cmd: string, value?: string) {
  focusNoteEditor()
  try {
    if (cmd === 'formatBlock' && value) {
      const ok = document.execCommand('formatBlock', false, value)
      if (!ok) document.execCommand('formatBlock', false, `<${value}>`)
      return
    }
    document.execCommand(cmd, false, value)
  } catch {
    /* ignore */
  }
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
      className="notes-editor min-h-[14rem] flex-1 px-5 py-4 text-[15px] leading-relaxed text-[var(--color-fg)] outline-none [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6"
      contentEditable={canEdit}
      suppressContentEditableWarning
      onInput={() => onHtmlChangeRef.current(elRef.current?.innerHTML ?? '', 'edit')}
      onBlur={() => onHtmlChangeRef.current(elRef.current?.innerHTML ?? '', 'blur')}
    />
  )
})

export function NotesPage() {
  const t = useT()
  const toast = useToast()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedId = Number(searchParams.get('id') || 0) || null

  const [list, setList] = useState<NoteListItem[]>([])
  const [panelUsers, setPanelUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [note, setNote] = useState<NoteRow | null>(null)
  const [title, setTitle] = useState('')
  const [planStart, setPlanStart] = useState('')
  const [planEnd, setPlanEnd] = useState('')
  const [sameDayEnd, setSameDayEnd] = useState(false)
  const [color, setColor] = useState<NoteColor | null>(null)
  const [mark, setMark] = useState<NoteMark | null>(null)
  const [calendarTick, setCalendarTick] = useState(0)
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
    setList(items)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const [items, users] = await Promise.all([api.notes(), api.users()])
        if (cancelled) return
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
        setCalendarTick((n) => n + 1)
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
      setCalendarTick((n) => n + 1)
      setSearchParams({ id: String(row.id) })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('notes.saveFailed'))
    }
  }

  const removeNote = async () => {
    if (!note || !isOwner) return
    if (!window.confirm(t('notes.deleteConfirm'))) return
    try {
      await api.deleteNote(note.id)
      setNote(null)
      setSearchParams({})
      await reloadList()
      setCalendarTick((n) => n + 1)
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

  return (
    <div>
      <h1 className="sr-only">{t('notes.title')}</h1>
      <div className="grid gap-4 lg:grid-cols-[minmax(14rem,18rem)_1fr]">
        <aside className="app-panel !p-3">
          <DashboardCalendar
            compact
            embedded
            plansOnly
            hideNotesLink
            selectedNoteId={selectedId}
            refreshKey={calendarTick}
            onSelectPlan={(id) => setSearchParams({ id: String(id) })}
          />
          <button
            type="button"
            onClick={() => void createNote()}
            className="my-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
          >
            <span className="text-lg leading-none" aria-hidden>
              +
            </span>
            {t('notes.create')}
          </button>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
            {t('notes.list')}
          </div>
          {loading ? (
            <p className="px-1 py-3 text-xs text-[var(--color-fg-subtle)]">{t('common.loading')}</p>
          ) : list.length === 0 ? (
            <p className="px-1 py-3 text-xs text-[var(--color-fg-subtle)]">{t('notes.empty')}</p>
          ) : (
            <ul className="max-h-[min(40vh,22rem)] space-y-1 overflow-y-auto">
              {list.map((item) => {
                const active = item.id === selectedId
                const plan = formatPlan(item)
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setSearchParams({ id: String(item.id) })}
                      className={`w-full rounded-xl px-2.5 py-2 text-left transition ${
                        active
                          ? 'bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                          : 'hover:bg-[var(--color-surface-muted)] text-[var(--color-fg)]'
                      }`}
                    >
                      <span className="block truncate text-[13px] font-medium">
                        {item.mark ? `${MARK_GLYPH[item.mark]} ` : ''}
                        {item.title || t('notes.untitled')}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-[var(--color-fg-subtle)]">
                        {item.color ? (
                          <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${COLOR_SWATCH[item.color]}`} />
                        ) : null}
                        <span className="truncate">
                          {[
                            item.is_shared_with_me ? t('notes.sharedBadge') : null,
                            plan,
                            item.owner_username,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </aside>

        <section className="app-panel !p-0 overflow-hidden">
          {!note ? (
            <div className="flex min-h-[22rem] flex-col items-center justify-center gap-3 px-6 text-center">
              <IconBook className="h-10 w-10 text-[var(--color-fg-subtle)]" />
              <p className="max-w-sm text-sm text-[var(--color-fg-muted)]">{t('notes.pickOrCreate')}</p>
            </div>
          ) : (
            <div className="flex min-h-[28rem] flex-col">
              <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
                <input
                  className="app-input !min-h-0 flex-1 !border-0 !bg-transparent !px-0 !text-lg !font-semibold !shadow-none"
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
                    className="rounded-lg p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-danger)]"
                    onClick={() => void removeNote()}
                    title={t('notes.delete')}
                  >
                    <IconTrash className="h-4 w-4" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-lg p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] lg:hidden"
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
                <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--color-border)] px-3 py-1.5">
                  {(
                    [
                      ['bold', t('notes.fmtBold'), () => execCmd('bold')],
                      ['italic', t('notes.fmtItalic'), () => execCmd('italic')],
                      ['ul', t('notes.fmtList'), () => execCmd('insertUnorderedList')],
                      ['h', t('notes.fmtHeading'), () => execCmd('formatBlock', 'h2')],
                      ['p', t('notes.fmtParagraph'), () => execCmd('formatBlock', 'p')],
                    ] as const
                  ).map(([key, label, fn]) => (
                    <button
                      key={key}
                      type="button"
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-[var(--color-fg-muted)] transition hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        fn()
                        const el = document.querySelector('.notes-editor')
                        if (el instanceof HTMLElement) bodyHtmlRef.current = el.innerHTML
                        void persistNowRef.current()
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-fg-subtle)]">
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

              <div className="grid gap-4 border-t border-[var(--color-border)] bg-[var(--color-surface-muted)]/30 p-4 sm:grid-cols-2">
                <div>
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                    <IconPencil className="h-3.5 w-3.5" />
                    {t('notes.planDates')}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <label className="text-xs text-[var(--color-fg-muted)]">
                      {t('notes.planStart')}
                      <input
                        type="date"
                        className="app-input mt-1 !min-h-[2.25rem] !text-sm"
                        value={planStart}
                        disabled={!canEdit}
                        onChange={(e) => applyPlanStart(e.target.value)}
                      />
                    </label>
                    <label className="text-xs text-[var(--color-fg-muted)]">
                      {t('notes.planEnd')}
                      <input
                        type="date"
                        className="app-input mt-1 !min-h-[2.25rem] !text-sm"
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

                  <div className="mt-3">
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                      {t('notes.planColor')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => applyColor(null)}
                        className={`h-6 rounded-md border px-2 text-[10px] font-medium ${
                          color == null
                            ? 'border-[var(--color-fg)] text-[var(--color-fg)]'
                            : 'border-[var(--color-border)] text-[var(--color-fg-muted)]'
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
                          className={`h-6 w-6 rounded-full ${COLOR_SWATCH[token]} ${
                            color === token ? 'ring-2 ring-[var(--color-fg)] ring-offset-1 ring-offset-[var(--color-surface)]' : ''
                          }`}
                          aria-label={t(`notes.colors.${token}`)}
                        />
                      ))}
                    </div>
                  </div>

                  <div className="mt-3">
                    <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                      {t('notes.planMark')}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        disabled={!canEdit}
                        onClick={() => applyMark(null)}
                        className={`h-7 rounded-md border px-2 text-[10px] font-medium ${
                          mark == null
                            ? 'border-[var(--color-fg)] text-[var(--color-fg)]'
                            : 'border-[var(--color-border)] text-[var(--color-fg-muted)]'
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
                          className={`flex h-7 w-7 items-center justify-center rounded-md border text-sm ${
                            mark === token
                              ? 'border-[var(--color-fg)] bg-[var(--color-surface)] text-[var(--color-fg)]'
                              : 'border-[var(--color-border)] text-[var(--color-fg-muted)]'
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
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
                      {t('notes.access')}
                    </div>
                    <p className="mb-2 text-[11px] text-[var(--color-fg-subtle)]">{t('notes.accessHint')}</p>
                    <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
                      {shareCandidates.length === 0 ? (
                        <p className="px-1 py-2 text-xs text-[var(--color-fg-subtle)]">{t('notes.noUsers')}</p>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 rounded-lg border-b border-[var(--color-border)] px-1.5 pb-1.5 mb-0.5">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={allShared}
                              onChange={toggleShareAll}
                            />
                            <span className="min-w-0 flex-1 text-xs font-semibold text-[var(--color-fg)]">
                              {t('notes.shareEveryone')}
                            </span>
                            <span className="text-[10px] text-[var(--color-fg-subtle)]">
                              {t('notes.shareEveryoneHint')}
                            </span>
                          </div>
                          {shareCandidates.map((u) => {
                            const row = shareDraft.find((x) => x.user_id === u.id)
                            return (
                              <div key={u.id} className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-[var(--color-surface-muted)]">
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
                    <button type="button" className="app-btn-secondary mt-2 !text-xs" onClick={() => void saveShares()}>
                      {t('notes.saveShares')}
                    </button>
                  </div>
                ) : (
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
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
    </div>
  )
}
