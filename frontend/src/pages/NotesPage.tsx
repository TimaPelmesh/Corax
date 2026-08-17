import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api, type NoteListItem, type NoteRow, type User } from '../api'
import { useAuth } from '../AuthContext'
import { IconBook, IconClose, IconPencil, IconTrash } from '../components/icons'
import { useT } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import { formatNotePlanRange } from '../lib/notesPlan'

function execCmd(cmd: string, value?: string) {
  try {
    document.execCommand(cmd, false, value)
  } catch {
    /* ignore */
  }
}

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
  const [shareDraft, setShareDraft] = useState<{ user_id: number; can_edit: boolean }[]>([])
  const [saving, setSaving] = useState(false)
  const [saveLabel, setSaveLabel] = useState<string | null>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | null>(null)
  const skipNextBodySync = useRef(false)
  const titleRef = useRef(title)
  const planStartRef = useRef(planStart)
  const planEndRef = useRef(planEnd)
  const noteRef = useRef(note)

  titleRef.current = title
  planStartRef.current = planStart
  planEndRef.current = planEnd
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

  useEffect(() => {
    if (!selectedId) {
      setNote(null)
      return
    }
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    let cancelled = false
    void (async () => {
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
        setShareDraft(row.shares.map((s) => ({ user_id: s.user_id, can_edit: s.can_edit })))
        skipNextBodySync.current = true
        if (editorRef.current) editorRef.current.innerHTML = row.body_html || ''
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

  /** Debounced save; reads latest title/dates from refs so onChange does not race setState. */
  const scheduleSave = useCallback(() => {
    const current = noteRef.current
    if (!current?.can_edit) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void (async () => {
        const row = noteRef.current
        if (!row?.can_edit) return
        setSaving(true)
        try {
          const body_html = editorRef.current?.innerHTML ?? row.body_html
          const updated = await api.updateNote(row.id, {
            title: titleRef.current,
            body_html,
            plan_start: planStartRef.current || null,
            plan_end: planEndRef.current || null,
          })
          setNote(updated)
          setSaveLabel(t('notes.saved'))
          await reloadList()
        } catch (e) {
          toast.error(e instanceof Error ? e.message : t('notes.saveFailed'))
        } finally {
          setSaving(false)
          window.setTimeout(() => setSaveLabel(null), 2000)
        }
      })()
    }, 450)
  }, [reloadList, t, toast])

  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
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
    if (!window.confirm(t('notes.deleteConfirm'))) return
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
          <button
            type="button"
            onClick={() => void createNote()}
            className="mb-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-[var(--color-primary)] px-4 text-sm font-semibold text-white shadow-sm transition hover:opacity-90"
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
            <ul className="max-h-[min(70vh,36rem)] space-y-1 overflow-y-auto">
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
                      <span className="block truncate text-[13px] font-medium">{item.title || t('notes.untitled')}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--color-fg-subtle)]">
                        {[
                          item.is_shared_with_me ? t('notes.sharedBadge') : null,
                          plan,
                          item.owner_username,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
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
                        scheduleSave()
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

              <div
                ref={editorRef}
                className="notes-editor min-h-[14rem] flex-1 px-5 py-4 text-[15px] leading-relaxed text-[var(--color-fg)] outline-none [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-6"
                contentEditable={canEdit}
                suppressContentEditableWarning
                onInput={() => {
                  if (skipNextBodySync.current) {
                    skipNextBodySync.current = false
                    return
                  }
                  scheduleSave()
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
