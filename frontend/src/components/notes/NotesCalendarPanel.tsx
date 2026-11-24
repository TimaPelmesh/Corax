import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { IconChevronLeft, IconChevronRight, IconTrash } from '../icons'

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

type RuleMode = 'weekdays' | 'monthdays' | 'range'

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

function mondayIndex(value: Date): number {
  return (value.getDay() + 6) % 7
}

function expandMarkDays(mark: CalendarMark): string[] {
  const exceptions = new Set(mark.exceptions ?? [])
  const weekdays = mark.weekdays ?? []
  const monthDays = mark.month_days ?? []
  const out: string[] = []
  for (const cur = parseDate(mark.start_date); cur <= parseDate(mark.end_date); cur.setDate(cur.getDate() + 1)) {
    const key = dateKey(cur)
    if (exceptions.has(key)) continue
    if (monthDays.length > 0) {
      if (!monthDays.includes(cur.getDate())) continue
    } else if (weekdays.length > 0) {
      if (!weekdays.includes(mondayIndex(cur))) continue
    }
    out.push(key)
  }
  return out
}

function yearBounds(year: number): { from: string; to: string } {
  return { from: `${year}-01-01`, to: `${year}-12-31` }
}

function defaultYearRange(): { start: string; end: string } {
  const y = new Date().getFullYear()
  return { start: `${y}-01-01`, end: `${y}-12-31` }
}

function isRuleMark(mark: CalendarMark): boolean {
  return (mark.weekdays?.length ?? 0) > 0 || (mark.month_days?.length ?? 0) > 0
}

type PlanHit = { note: NoteListItem; key: string }

export function NotesCalendarPanel({
  notes,
  onSelectNote,
}: {
  notes: NoteListItem[]
  onSelectNote: (noteId: number) => void
}) {
  const t = useT()
  const { locale } = useLocale()
  const toast = useToast()
  const { user } = useAuth()
  const isAdmin = Boolean(user?.is_superuser)
  const yearDefault = useMemo(() => defaultYearRange(), [])

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
  const [formStart, setFormStart] = useState(yearDefault.start)
  const [formEnd, setFormEnd] = useState(yearDefault.end)
  const [formWeekdays, setFormWeekdays] = useState<number[]>([5, 6])
  const [formMonthDays, setFormMonthDays] = useState<number[]>([10, 25])
  const [mode, setMode] = useState<RuleMode>('weekdays')
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
      const year = anchor.getFullYear()
      const bounds = yearBounds(year)
      const from = windowFrom < bounds.from ? windowFrom : bounds.from
      const to = windowTo > bounds.to ? windowTo : bounds.to
      const rows = await api.calendarMarks(from, to)
      setMarks(
        rows.map((row) => ({
          ...row,
          weekdays: row.weekdays ?? [],
          month_days: row.month_days ?? [],
          exceptions: row.exceptions ?? [],
        })),
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('notes.calendar.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [anchor, toast, t, windowFrom, windowTo])

  useEffect(() => {
    void reloadMarks()
  }, [reloadMarks])

  const markByDay = useMemo(() => {
    const map = new Map<string, CalendarMark[]>()
    for (const mark of marks) {
      for (const key of expandMarkDays(mark)) {
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
      for (const cur = parseDate(start); cur <= parseDate(end); cur.setDate(cur.getDate() + 1)) {
        const key = dateKey(cur)
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
    const out = new Set<string>()
    for (const cur = parseDate(a); cur <= parseDate(b); cur.setDate(cur.getDate() + 1)) {
      out.add(dateKey(cur))
    }
    return out
  }, [rangeStart, rangeHover])

  async function toggleException(mark: CalendarMark, day: string) {
    if (!mark.can_edit) return
    const has = mark.exceptions.includes(day)
    const next = has ? mark.exceptions.filter((d) => d !== day) : [...mark.exceptions, day].sort()
    try {
      await api.updateCalendarMark(mark.id, { exceptions: next })
      toast.ok(has ? t('notes.calendar.exceptionRemoved') : t('notes.calendar.exceptionAdded'))
      await reloadMarks()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('notes.calendar.saveFailed'))
    }
  }

  function applyDayClick(key: string) {
    const covering = (markByDay.get(key) ?? []).filter((m) => m.can_edit && isRuleMark(m))
    if (covering.length && !rangeStart) {
      void toggleException(covering[0], key)
      return
    }

    if (!rangeStart) {
      setRangeStart(key)
      setRangeHover(key)
      setFormStart(key)
      setFormEnd(key)
      if (mode !== 'range') setMode('range')
      return
    }
    const a = rangeStart <= key ? rangeStart : key
    const b = rangeStart <= key ? key : rangeStart
    setFormStart(a)
    setFormEnd(b)
    setRangeStart(null)
    setRangeHover(null)
  }

  function toggleWeekday(day: number) {
    setFormWeekdays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    )
  }

  function toggleMonthDay(day: number) {
    setFormMonthDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort((a, b) => a - b),
    )
  }

  function applyPreset(kind: 'weekend' | 'payday' | 'range') {
    if (kind === 'weekend') {
      setMode('weekdays')
      setFormKind('weekend')
      setFormWeekdays([5, 6])
      setFormMonthDays([])
      setFormTitle('')
      setFormStart(yearDefault.start)
      setFormEnd(yearDefault.end)
      return
    }
    if (kind === 'payday') {
      setMode('monthdays')
      setFormKind('payday')
      setFormMonthDays([10, 25])
      setFormWeekdays([])
      setFormTitle(t('notes.calendar.presetPayTitle'))
      setFormStart(yearDefault.start)
      setFormEnd(yearDefault.end)
      return
    }
    setMode('range')
    setFormKind('holiday')
    setFormWeekdays([])
    setFormMonthDays([])
  }

  async function saveMark() {
    if (!formStart || !formEnd) {
      toast.error(t('notes.calendar.needRange'))
      return
    }
    if (mode === 'weekdays' && formWeekdays.length === 0) {
      toast.error(t('notes.calendar.needWeekdays'))
      return
    }
    if (mode === 'monthdays' && formMonthDays.length === 0) {
      toast.error(t('notes.calendar.needMonthDays'))
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
        weekdays: mode === 'weekdays' ? formWeekdays : [],
        month_days: mode === 'monthdays' ? formMonthDays : [],
        exceptions: [],
      })
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

  const todayKey = dateKey(new Date())
  const headerRange = `${monthLabel(months[0], locale)} — ${monthLabel(months[2], locale)}`
  const monthDayChoices = [1, 5, 10, 15, 20, 25, 28, 30]

  return (
    <div className="notes-cal-panel">
      <header className="notes-cal-panel__header">
        <div>
          <h2 className="notes-cal-panel__title">{t('notes.calendar.title')}</h2>
          <p className="notes-cal-panel__sub">{headerRange}</p>
        </div>
        <div className="notes-cal-header__nav">
          <button
            type="button"
            className="notes-cal-nav-btn"
            onClick={() => setAnchor((m) => addMonths(m, -1))}
            aria-label={t('notes.calendar.prev')}
          >
            <IconChevronLeft className="h-4 w-4" />
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
            <IconChevronRight className="h-4 w-4" />
          </button>
        </div>
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
                    const isException = marks.some((m) => isRuleMark(m) && m.exceptions.includes(key))
                    return (
                      <button
                        key={key}
                        type="button"
                        className={[
                          'notes-cal-day',
                          primaryKind ? KIND_TINT[primaryKind] : '',
                          selected ? 'notes-cal-day--selected' : '',
                          isToday ? 'notes-cal-day--today' : '',
                          isException ? 'notes-cal-day--exception' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        title={
                          dayMarks.some((m) => m.can_edit && isRuleMark(m))
                            ? t('notes.calendar.exceptionHint')
                            : undefined
                        }
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
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  onSelectNote(note.id)
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
          <div className="notes-cal-quick">
            <button type="button" className="notes-cal-quick__btn" onClick={() => applyPreset('weekend')}>
              {t('notes.calendar.presetWeekend')}
            </button>
            <button type="button" className="notes-cal-quick__btn" onClick={() => applyPreset('payday')}>
              {t('notes.calendar.presetPay')}
            </button>
            <button type="button" className="notes-cal-quick__btn" onClick={() => applyPreset('range')}>
              {t('notes.calendar.presetDates')}
            </button>
          </div>

          <div className="notes-cal-form">
            <h3 className="notes-cal-form__title">{t('notes.calendar.addTitle')}</h3>
            <p className="notes-cal-form__hint">{t('notes.calendar.addHintSimple')}</p>

            <div className="notes-cal-mode">
              <button
                type="button"
                className={`notes-cal-mode__btn${mode === 'weekdays' ? ' is-active' : ''}`}
                onClick={() => setMode('weekdays')}
              >
                {t('notes.calendar.modeWeekdays')}
              </button>
              <button
                type="button"
                className={`notes-cal-mode__btn${mode === 'monthdays' ? ' is-active' : ''}`}
                onClick={() => {
                  setMode('monthdays')
                  if (formKind === 'weekend') setFormKind('payday')
                }}
              >
                {t('notes.calendar.modeMonthDays')}
              </button>
              <button
                type="button"
                className={`notes-cal-mode__btn${mode === 'range' ? ' is-active' : ''}`}
                onClick={() => setMode('range')}
              >
                {t('notes.calendar.modeRange')}
              </button>
            </div>

            <div className="notes-cal-kind-row">
              {(['weekend', 'holiday', 'payday'] as CalendarMarkKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`notes-cal-kind${formKind === kind ? ' is-active' : ''} notes-cal-kind--${kind}`}
                  onClick={() => setFormKind(kind)}
                >
                  {t(KIND_LABEL_KEY[kind])}
                </button>
              ))}
            </div>

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

            {mode === 'weekdays' ? (
              <div className="notes-cal-field">
                <span>{t('notes.calendar.weekdays')}</span>
                <div className="notes-cal-weekday-toggles">
                  {WEEKDAY_KEYS.map((key, index) => {
                    const active = formWeekdays.includes(index)
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`notes-cal-wd${active ? ' is-active' : ''}`}
                        onClick={() => toggleWeekday(index)}
                      >
                        {t(key)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : null}

            {mode === 'monthdays' ? (
              <div className="notes-cal-field">
                <span>{t('notes.calendar.monthDays')}</span>
                <div className="notes-cal-monthday-toggles">
                  {monthDayChoices.map((day) => {
                    const active = formMonthDays.includes(day)
                    return (
                      <button
                        key={day}
                        type="button"
                        className={`notes-cal-md${active ? ' is-active' : ''}`}
                        onClick={() => toggleMonthDay(day)}
                      >
                        {day}
                      </button>
                    )
                  })}
                </div>
                <input
                  type="text"
                  className="app-input mt-1"
                  value={formMonthDays.join(', ')}
                  onChange={(event) => {
                    const parsed = event.target.value
                      .split(/[,\s]+/)
                      .map((part) => Number(part))
                      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 31)
                    setFormMonthDays([...new Set(parsed)].sort((a, b) => a - b))
                  }}
                  placeholder={t('notes.calendar.monthDaysPlaceholder')}
                />
              </div>
            ) : null}

            <label className="notes-cal-field">
              <span>{t('notes.calendar.visibilityLabel')}</span>
              <select
                value={formVisibility}
                onChange={(event) => setFormVisibility(event.target.value as CalendarMarkVisibility)}
                className="app-input"
              >
                <option value="private">{t('notes.calendar.visibility.private')}</option>
                <option value="shared">{t('notes.calendar.visibility.shared')}</option>
                {isAdmin ? <option value="org">{t('notes.calendar.visibility.org')}</option> : null}
              </select>
            </label>

            <button
              type="button"
              className="app-btn app-btn-primary w-full"
              disabled={
                saving ||
                !formStart ||
                !formEnd ||
                (mode === 'weekdays' && formWeekdays.length === 0) ||
                (mode === 'monthdays' && formMonthDays.length === 0)
              }
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
                          {mark.month_days.length > 0
                            ? ` · ${t('notes.calendar.monthDaysShort', { days: mark.month_days.join(', ') })}`
                            : mark.weekdays.length > 0
                              ? ` · ${mark.weekdays.map((d) => t(WEEKDAY_KEYS[d])).join(', ')}`
                              : ` · ${t('notes.calendar.modeRange')}`}
                          {' · '}
                          {t(VISIBILITY_LABEL_KEY[mark.visibility])}
                          {mark.exceptions.length > 0
                            ? ` · ${t('notes.calendar.exceptionsCount', { n: mark.exceptions.length })}`
                            : null}
                          {!mark.mine && mark.owner_username ? ` · ${mark.owner_username}` : null}
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
  )
}
