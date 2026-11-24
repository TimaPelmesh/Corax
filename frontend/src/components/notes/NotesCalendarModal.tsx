import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  api,
  type CalendarMark,
  type CalendarMarkKind,
  type CalendarMarkVisibility,
  type NoteColor,
  type NoteListItem,
  type NoteMark,
} from '../../api'
import { useAuth } from '../../AuthContext'
import { useLocale, useT, type MessageKey } from '../../i18n/LocaleContext'
import { useToast } from '../../ToastContext'
import { IconCalendar, IconClose, IconTrash } from '../icons'

const WEEKDAY_KEYS = [
  'dashboard.calendar.weekdays.mon',
  'dashboard.calendar.weekdays.tue',
  'dashboard.calendar.weekdays.wed',
  'dashboard.calendar.weekdays.thu',
  'dashboard.calendar.weekdays.fri',
  'dashboard.calendar.weekdays.sat',
  'dashboard.calendar.weekdays.sun',
] as const

const PLAN_CHIP: Record<NoteColor, string> = {
  blue: 'bg-sky-500/90 text-white',
  green: 'bg-emerald-500/90 text-white',
  amber: 'bg-amber-500/90 text-white',
  rose: 'bg-rose-500/90 text-white',
  violet: 'bg-violet-500/90 text-white',
  slate: 'bg-slate-500/90 text-white',
}

const MARK_GLYPH: Record<NoteMark, string> = {
  dot: '●',
  flag: '⚑',
  star: '★',
}

const KIND_TINT: Record<CalendarMarkKind, string> = {
  weekend: 'notes-cal-day--weekend',
  holiday: 'notes-cal-day--holiday',
  payday: 'notes-cal-day--payday',
}

function dateKey(value: Date): string {
  const y = value.getFullYear()
  const m = String(value.getMonth() + 1).padStart(2, '0')
  const d = String(value.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

function addMonths(value: Date, amount: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1)
}

function monthLabel(value: Date, locale: string): string {
  return value.toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'long',
    year: 'numeric',
  })
}

function daysInMonthGrid(month: Date): (Date | null)[] {
  const year = month.getFullYear()
  const mon = month.getMonth()
  const first = new Date(year, mon, 1)
  const startPad = (first.getDay() + 6) % 7
  const count = new Date(year, mon + 1, 0).getDate()
  const cells: (Date | null)[] = []
  for (let i = 0; i < startPad; i++) cells.push(null)
  for (let d = 1; d <= count; d++) cells.push(new Date(year, mon, d))
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}

function expandRange(start: string, end: string): string[] {
  const out: string[] = []
  for (const cur = parseDate(start); cur <= parseDate(end); cur.setDate(cur.getDate() + 1)) {
    out.push(dateKey(cur))
  }
  return out
}

const KIND_LABEL_KEY: Record<CalendarMarkKind, MessageKey> = {
  weekend: 'notes.calendar.kinds.weekend',
  holiday: 'notes.calendar.kinds.holiday',
  payday: 'notes.calendar.kinds.payday',
}

const VISIBILITY_LABEL_KEY: Record<CalendarMarkVisibility, MessageKey> = {
  private: 'notes.calendar.visibility.private',
  shared: 'notes.calendar.visibility.shared',
  org: 'notes.calendar.visibility.org',
}

type PlanHit = { note: NoteListItem; key: string }

export function NotesCalendarModal({
  open,
  onClose,
  notes,
  onSelectNote,
}: {
  open: boolean
  onClose: () => void
  notes: NoteListItem[]
  onSelectNote: (noteId: number) => void
}) {
  const t = useT()
  const { locale } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = Boolean(user?.is_superuser)

  const [anchor, setAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [marks, setMarks] = useState<CalendarMark[]>([])
  const [loading, setLoading] = useState(false)
  const [rangeStart, setRangeStart] = useState<string | null>(null)
  const [rangeHover, setRangeHover] = useState<string | null>(null)
  const [formKind, setFormKind] = useState<CalendarMarkKind>('weekend')
  const [formTitle, setFormTitle] = useState('')
  const [formVisibility, setFormVisibility] = useState<CalendarMarkVisibility>('private')
  const [formStart, setFormStart] = useState('')
  const [formEnd, setFormEnd] = useState('')
  const [saving, setSaving] = useState(false)

  const months = useMemo(() => [addMonths(anchor, -1), anchor, addMonths(anchor, 1)], [anchor])

  const windowFrom = useMemo(() => dateKey(months[0]), [months])
  const windowTo = useMemo(() => {
    const last = months[2]
    return dateKey(new Date(last.getFullYear(), last.getMonth() + 1, 0))
  }, [months])

  const reloadMarks = useCallback(async () => {
    setLoading(true)
    try {
      const rows = await api.calendarMarks(windowFrom, windowTo)
      setMarks(rows)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('notes.calendar.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [toast, t, windowFrom, windowTo])

  useEffect(() => {
    if (!open) return
    void reloadMarks()
  }, [open, reloadMarks])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const markByDay = useMemo(() => {
    const map = new Map<string, CalendarMark[]>()
    for (const mark of marks) {
      for (const key of expandRange(mark.start_date, mark.end_date)) {
        const list = map.get(key) ?? []
        list.push(mark)
        map.set(key, list)
      }
    }
    return map
  }, [marks])

  const plansByDay = useMemo(() => {
    const map = new Map<string, PlanHit[]>()
    for (const note of notes) {
      const start = note.plan_start
      if (!start) continue
      const end = note.plan_end || start
      for (const key of expandRange(start, end)) {
        const list = map.get(key) ?? []
        list.push({ note, key })
        map.set(key, list)
      }
    }
    return map
  }, [notes])

  const selectionKeys = useMemo(() => {
    if (!rangeStart) return new Set<string>()
    const end = rangeHover || rangeStart
    const a = rangeStart <= end ? rangeStart : end
    const b = rangeStart <= end ? end : rangeStart
    return new Set(expandRange(a, b))
  }, [rangeStart, rangeHover])

  function applyDayClick(key: string) {
    if (!rangeStart) {
      setRangeStart(key)
      setRangeHover(key)
      setFormStart(key)
      setFormEnd(key)
      return
    }
    const a = rangeStart <= key ? rangeStart : key
    const b = rangeStart <= key ? key : rangeStart
    setFormStart(a)
    setFormEnd(b)
    setRangeStart(null)
    setRangeHover(null)
  }

  async function saveMark() {
    if (!formStart || !formEnd) {
      toast.error(t('notes.calendar.needRange'))
      return
    }
    setSaving(true)
    try {
      await api.createCalendarMark({
        kind: formKind,
        title: formTitle.trim(),
        start_date: formStart,
        end_date: formEnd,
        visibility: formVisibility,
      })
      setFormTitle('')
      setFormStart('')
      setFormEnd('')
      setRangeStart(null)
      setRangeHover(null)
      toast.ok(t('notes.calendar.saved'))
      await reloadMarks()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('notes.calendar.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function removeMark(id: number) {
    try {
      await api.deleteCalendarMark(id)
      toast.ok(t('notes.calendar.deleted'))
      await reloadMarks()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('notes.calendar.deleteFailed'))
    }
  }

  if (!open) return null

  const todayKey = dateKey(new Date())
  const headerRange = `${monthLabel(months[0], locale)} — ${monthLabel(months[2], locale)}`

  return createPortal(
    <div className="notes-cal-layer" role="presentation" onClick={onClose}>
      <div
        className="notes-cal-shell"
        role="dialog"
        aria-modal="true"
        aria-label={t('notes.calendar.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="notes-cal-header">
          <div className="notes-cal-header__brand">
            <span className="notes-cal-header__icon" aria-hidden>
              <IconCalendar className="h-5 w-5" />
            </span>
            <div>
              <h2 className="notes-cal-header__title">{t('notes.calendar.title')}</h2>
              <p className="notes-cal-header__sub">{headerRange}</p>
            </div>
          </div>
          <div className="notes-cal-header__nav">
            <button
              type="button"
              className="notes-cal-nav-btn"
              onClick={() => setAnchor((m) => addMonths(m, -1))}
              aria-label={t('notes.calendar.prev')}
            >
              ‹
            </button>
            <button
              type="button"
              className="notes-cal-nav-btn notes-cal-nav-btn--today"
              onClick={() => {
                const now = new Date()
                setAnchor(new Date(now.getFullYear(), now.getMonth(), 1))
              }}
            >
              {t('notes.calendar.today')}
            </button>
            <button
              type="button"
              className="notes-cal-nav-btn"
              onClick={() => setAnchor((m) => addMonths(m, 1))}
              aria-label={t('notes.calendar.next')}
            >
              ›
            </button>
          </div>
          <button
            type="button"
            className="notes-cal-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconClose className="h-5 w-5" />
          </button>
        </header>

        <div className="notes-cal-body">
          <div className="notes-cal-months" aria-busy={loading}>
            {months.map((month) => {
              const cells = daysInMonthGrid(month)
              return (
                <section key={dateKey(month)} className="notes-cal-month">
                  <h3 className="notes-cal-month__title">{monthLabel(month, locale)}</h3>
                  <div className="notes-cal-weekdays">
                    {WEEKDAY_KEYS.map((key) => (
                      <span key={key} className="notes-cal-weekday">
                        {t(key)}
                      </span>
                    ))}
                  </div>
                  <div className="notes-cal-grid">
                    {cells.map((day, idx) => {
                      if (!day) {
                        return <div key={`pad-${idx}`} className="notes-cal-day notes-cal-day--empty" />
                      }
                      const key = dateKey(day)
                      const dayMarks = markByDay.get(key) ?? []
                      const plans = plansByDay.get(key) ?? []
                      const primaryKind = dayMarks[0]?.kind
                      const selected = selectionKeys.has(key)
                      const isToday = key === todayKey
                      return (
                        <button
                          key={key}
                          type="button"
                          className={[
                            'notes-cal-day',
                            primaryKind ? KIND_TINT[primaryKind] : '',
                            selected ? 'notes-cal-day--selected' : '',
                            isToday ? 'notes-cal-day--today' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => applyDayClick(key)}
                          onMouseEnter={() => {
                            if (rangeStart) setRangeHover(key)
                          }}
                        >
                          <span className="notes-cal-day__num">{day.getDate()}</span>
                          {dayMarks.length > 0 ? (
                            <span className="notes-cal-day__dots" aria-hidden>
                              {dayMarks.slice(0, 3).map((m) => (
                                <i key={m.id} className={`notes-cal-dot notes-cal-dot--${m.kind}`} />
                              ))}
                            </span>
                          ) : null}
                          <span className="notes-cal-day__plans">
                            {plans.slice(0, 2).map(({ note }) => (
                              <span
                                key={note.id}
                                role="link"
                                tabIndex={0}
                                className={`notes-cal-chip ${note.color ? PLAN_CHIP[note.color] : 'bg-[var(--color-primary)] text-white'}`}
                                title={note.title || t('notes.untitled')}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  onSelectNote(note.id)
                                  onClose()
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onSelectNote(note.id)
                                    onClose()
                                  }
                                }}
                              >
                                {note.mark ? `${MARK_GLYPH[note.mark]} ` : ''}
                                {note.title || t('notes.untitled')}
                              </span>
                            ))}
                            {plans.length > 2 ? (
                              <span className="notes-cal-chip-more">+{plans.length - 2}</span>
                            ) : null}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>

          <aside className="notes-cal-rail">
            <div className="notes-cal-legend">
              <div className="notes-cal-legend__row">
                <i className="notes-cal-dot notes-cal-dot--weekend" />
                <span>{t('notes.calendar.kinds.weekend')}</span>
              </div>
              <div className="notes-cal-legend__row">
                <i className="notes-cal-dot notes-cal-dot--holiday" />
                <span>{t('notes.calendar.kinds.holiday')}</span>
              </div>
              <div className="notes-cal-legend__row">
                <i className="notes-cal-dot notes-cal-dot--payday" />
                <span>{t('notes.calendar.kinds.payday')}</span>
              </div>
            </div>

            <div className="notes-cal-form">
              <h3 className="notes-cal-form__title">{t('notes.calendar.addTitle')}</h3>
              <p className="notes-cal-form__hint">{t('notes.calendar.addHint')}</p>

              <label className="notes-cal-field">
                <span>{t('notes.calendar.kind')}</span>
                <select
                  value={formKind}
                  onChange={(event) => setFormKind(event.target.value as CalendarMarkKind)}
                  className="app-input"
                >
                  <option value="weekend">{t('notes.calendar.kinds.weekend')}</option>
                  <option value="holiday">{t('notes.calendar.kinds.holiday')}</option>
                  <option value="payday">{t('notes.calendar.kinds.payday')}</option>
                </select>
              </label>

              <label className="notes-cal-field">
                <span>{t('notes.calendar.label')}</span>
                <input
                  type="text"
                  value={formTitle}
                  onChange={(event) => setFormTitle(event.target.value)}
                  className="app-input"
                  placeholder={t('notes.calendar.labelPlaceholder')}
                />
              </label>

              <div className="notes-cal-field-row">
                <label className="notes-cal-field">
                  <span>{t('notes.calendar.from')}</span>
                  <input
                    type="date"
                    value={formStart}
                    onChange={(event) => setFormStart(event.target.value)}
                    className="app-input"
                  />
                </label>
                <label className="notes-cal-field">
                  <span>{t('notes.calendar.to')}</span>
                  <input
                    type="date"
                    value={formEnd}
                    onChange={(event) => setFormEnd(event.target.value)}
                    className="app-input"
                  />
                </label>
              </div>

              <label className="notes-cal-field">
                <span>{t('notes.calendar.visibilityLabel')}</span>
                <select
                  value={formVisibility}
                  onChange={(event) => setFormVisibility(event.target.value as CalendarMarkVisibility)}
                  className="app-input"
                >
                  <option value="private">{t('notes.calendar.visibility.private')}</option>
                  <option value="shared">{t('notes.calendar.visibility.shared')}</option>
                  {isAdmin ? (
                    <option value="org">{t('notes.calendar.visibility.org')}</option>
                  ) : null}
                </select>
              </label>

              <button
                type="button"
                className="app-btn app-btn-primary w-full"
                disabled={saving || !formStart || !formEnd}
                onClick={() => void saveMark()}
              >
                {saving ? t('notes.saving') : t('notes.calendar.save')}
              </button>
            </div>

            <div className="notes-cal-list">
              <h3 className="notes-cal-form__title">{t('notes.calendar.listTitle')}</h3>
              {marks.length === 0 ? (
                <p className="notes-cal-empty">{t('notes.calendar.listEmpty')}</p>
              ) : (
                <ul className="notes-cal-list__ul">
                  {marks.map((mark) => (
                    <li key={mark.id} className="notes-cal-list__item">
                      <div className="notes-cal-list__meta">
                        <i className={`notes-cal-dot notes-cal-dot--${mark.kind}`} />
                        <div>
                          <div className="notes-cal-list__name">
                            {mark.title || t(KIND_LABEL_KEY[mark.kind])}
                          </div>
                          <div className="notes-cal-list__dates">
                            {mark.start_date === mark.end_date
                              ? mark.start_date
                              : `${mark.start_date} → ${mark.end_date}`}
                            {' · '}
                            {t(VISIBILITY_LABEL_KEY[mark.visibility])}
                            {!mark.mine && mark.owner_username
                              ? ` · ${mark.owner_username}`
                              : null}
                          </div>
                        </div>
                      </div>
                      {mark.can_edit ? (
                        <button
                          type="button"
                          className="notes-cal-list__del"
                          onClick={() => void removeMark(mark.id)}
                          aria-label={t('notes.delete')}
                        >
                          <IconTrash className="h-4 w-4" />
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}
