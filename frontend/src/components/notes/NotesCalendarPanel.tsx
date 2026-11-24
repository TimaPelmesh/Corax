import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type CalendarMark,
  type CalendarMarkKind,
  type CalendarMarkVisibility,
  type NoteColor,
  type NoteListItem,
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

const PLAN_DOT: Record<NoteColor, string> = {
  blue: 'bg-sky-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
  slate: 'bg-slate-500',
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
  const [mode, setMode] = useState<RuleMode>('monthdays')
  const [rulesOpen, setRulesOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const windowFrom = useMemo(() => dateKey(anchor), [anchor])
  const windowTo = useMemo(
    () => dateKey(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)),
    [anchor],
  )

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

  const exceptionByDay = useMemo(() => {
    const map = new Map<string, CalendarMark>()
    for (const mark of marks) {
      if (!isRuleMark(mark)) continue
      for (const day of mark.exceptions ?? []) {
        if (!map.has(day)) map.set(day, mark)
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
    const exceptionMark = exceptionByDay.get(key)
    if (exceptionMark?.can_edit && !rangeStart) {
      void toggleException(exceptionMark, key)
      return
    }
    if (covering.length && !rangeStart) {
      void toggleException(covering[0], key)
      return
    }

    if (!rangeStart) {
      setRangeStart(key)
      setRangeHover(key)
      setFormStart(key)
      setFormEnd(key)
      setMode('range')
      setRulesOpen(true)
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

  function applyPreset(kind: 'weekend' | 'payday' | 'advance') {
    setRulesOpen(true)
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
      setFormMonthDays([25])
      setFormWeekdays([])
      setFormTitle(t('notes.calendar.presetPayOnlyTitle'))
      setFormStart(yearDefault.start)
      setFormEnd(yearDefault.end)
      return
    }
    setMode('monthdays')
    setFormKind('payday')
    setFormMonthDays([10])
    setFormWeekdays([])
    setFormTitle(t('notes.calendar.presetAdvanceTitle'))
    setFormStart(yearDefault.start)
    setFormEnd(yearDefault.end)
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
  const monthDayChoices = [1, 5, 10, 15, 20, 25, 28, 30]
  const cells = daysInMonthGrid(anchor)

  return (
    <div className="notes-cal-panel notes-cal-panel--workspace">
      <header className="notes-cal-panel__header">
        <div className="notes-cal-header__nav">
          <button
            type="button"
            className="app-btn app-btn-secondary !min-h-8 !w-8 !px-0 !py-0"
            onClick={() => setAnchor((m) => addMonths(m, -1))}
            aria-label={t('notes.calendar.prev')}
          >
            <IconChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary !min-h-8 !px-3 !py-0 text-xs"
            onClick={() => {
              const now = new Date()
              setAnchor(new Date(now.getFullYear(), now.getMonth(), 1))
            }}
          >
            {t('notes.calendar.today')}
          </button>
          <button
            type="button"
            className="app-btn app-btn-secondary !min-h-8 !w-8 !px-0 !py-0"
            onClick={() => setAnchor((m) => addMonths(m, 1))}
            aria-label={t('notes.calendar.next')}
          >
            <IconChevronRight className="h-4 w-4" />
          </button>
          <h3 className="notes-cal-month__title notes-cal-month__title--inline">
            {monthLabel(anchor, locale)}
          </h3>
        </div>

        <div className="notes-cal-quick">
          <button type="button" className="app-chip !min-h-0 !px-2.5 !py-1" onClick={() => applyPreset('weekend')}>
            {t('notes.calendar.presetWeekend')}
          </button>
          <button type="button" className="app-chip !min-h-0 !px-2.5 !py-1" onClick={() => applyPreset('advance')}>
            {t('notes.calendar.presetAdvance')}
          </button>
          <button type="button" className="app-chip !min-h-0 !px-2.5 !py-1" onClick={() => applyPreset('payday')}>
            {t('notes.calendar.presetPayOnly')}
          </button>
          <button
            type="button"
            className={`app-chip !min-h-0 !px-2.5 !py-1${rulesOpen ? ' app-chip--active' : ''}`}
            onClick={() => setRulesOpen((v) => !v)}
          >
            {t('notes.calendar.rulesToggle')}
          </button>
        </div>
      </header>

      <div className="notes-cal-months notes-cal-months--workspace" aria-busy={loading}>
        <section className="notes-cal-month">
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
              const exceptionMark = exceptionByDay.get(key)
              const firstPlan = plans[0]?.note
              return (
                <button
                  key={key}
                  type="button"
                  className={[
                    'notes-cal-day',
                    primaryKind ? KIND_TINT[primaryKind] : '',
                    selected ? 'notes-cal-day--selected' : '',
                    isToday ? 'notes-cal-day--today' : '',
                    exceptionMark ? 'notes-cal-day--exception' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={
                    firstPlan
                      ? firstPlan.title || t('notes.untitled')
                      : exceptionMark
                        ? t('notes.calendar.exceptionMarkHint')
                        : dayMarks.some((m) => m.can_edit && isRuleMark(m))
                          ? t('notes.calendar.exceptionHint')
                          : undefined
                  }
                  onClick={() => applyDayClick(key)}
                  onDoubleClick={(event) => {
                    if (!firstPlan) return
                    event.preventDefault()
                    onSelectNote(firstPlan.id)
                  }}
                  onMouseEnter={() => {
                    if (rangeStart) setRangeHover(key)
                  }}
                >
                  <span className={`notes-cal-day__num${isToday ? ' notes-cal-day__num--today' : ''}`}>
                    {day.getDate()}
                  </span>
                  <span className="notes-cal-day__marks" aria-hidden>
                    {exceptionMark ? (
                      <span className="notes-cal-day__ex">×</span>
                    ) : (
                      <>
                        {dayMarks.slice(0, 2).map((m) => (
                          <i key={m.id} className={`notes-cal-dot notes-cal-dot--${m.kind}`} />
                        ))}
                        {plans.slice(0, 2).map(({ note }) => (
                          <i
                            key={`p-${note.id}`}
                            className={`notes-cal-dot ${note.color ? PLAN_DOT[note.color] : 'bg-[var(--color-primary)]'}`}
                          />
                        ))}
                      </>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        </section>
      </div>

      {rulesOpen ? (
        <div className="notes-cal-rules">
          <div className="notes-cal-rules__form">
            <div className="notes-cal-mode">
              <button
                type="button"
                className={`app-chip !min-h-0 !px-2.5 !py-1${mode === 'monthdays' ? ' app-chip--active' : ''}`}
                onClick={() => setMode('monthdays')}
              >
                {t('notes.calendar.modeMonthDays')}
              </button>
              <button
                type="button"
                className={`app-chip !min-h-0 !px-2.5 !py-1${mode === 'weekdays' ? ' app-chip--active' : ''}`}
                onClick={() => setMode('weekdays')}
              >
                {t('notes.calendar.modeWeekdays')}
              </button>
              <button
                type="button"
                className={`app-chip !min-h-0 !px-2.5 !py-1${mode === 'range' ? ' app-chip--active' : ''}`}
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
                  className={`app-chip !min-h-0 !px-2.5 !py-1${formKind === kind ? ' app-chip--active' : ''}`}
                  onClick={() => setFormKind(kind)}
                >
                  {t(KIND_LABEL_KEY[kind])}
                </button>
              ))}
            </div>

            <div className="notes-cal-rules__row">
              <input
                type="text"
                value={formTitle}
                onChange={(event) => setFormTitle(event.target.value)}
                className="app-input !min-h-9 !py-1.5 text-sm"
                placeholder={t('notes.calendar.labelPlaceholder')}
              />
              <input
                type="date"
                value={formStart}
                onChange={(event) => setFormStart(event.target.value)}
                className="app-input !min-h-9 !py-1.5 text-sm"
              />
              <input
                type="date"
                value={formEnd}
                onChange={(event) => setFormEnd(event.target.value)}
                className="app-input !min-h-9 !py-1.5 text-sm"
              />
              <select
                value={formVisibility}
                onChange={(event) => setFormVisibility(event.target.value as CalendarMarkVisibility)}
                className="app-input !min-h-9 !py-1.5 text-sm"
              >
                <option value="private">{t('notes.calendar.visibility.private')}</option>
                <option value="shared">{t('notes.calendar.visibility.shared')}</option>
                {isAdmin ? <option value="org">{t('notes.calendar.visibility.org')}</option> : null}
              </select>
            </div>

            {mode === 'weekdays' ? (
              <div className="notes-cal-weekday-toggles">
                {WEEKDAY_KEYS.map((key, index) => (
                  <button
                    key={key}
                    type="button"
                    className={`app-chip !min-h-0 !justify-center !px-1.5 !py-1 text-[11px]${
                      formWeekdays.includes(index) ? ' app-chip--active' : ''
                    }`}
                    onClick={() => toggleWeekday(index)}
                  >
                    {t(key)}
                  </button>
                ))}
              </div>
            ) : null}

            {mode === 'monthdays' ? (
              <div className="notes-cal-monthday-toggles">
                {monthDayChoices.map((day) => (
                  <button
                    key={day}
                    type="button"
                    className={`app-chip !min-h-0 !min-w-8 !justify-center !px-2 !py-1 tabular-nums${
                      formMonthDays.includes(day) ? ' app-chip--active' : ''
                    }`}
                    onClick={() => toggleMonthDay(day)}
                  >
                    {day}
                  </button>
                ))}
                <input
                  type="text"
                  className="app-input notes-cal-monthday-input !min-h-8 !py-1 text-sm"
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

            <div className="notes-cal-rules__actions">
              <button
                type="button"
                className="app-btn app-btn-primary !min-h-9 !px-4 !py-1.5 text-sm"
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
          </div>

          {marks.length > 0 ? (
            <ul className="notes-cal-list__ul notes-cal-list__ul--compact">
              {marks.map((mark) => (
                <li key={mark.id} className="notes-cal-list__item">
                  <div className="notes-cal-list__meta">
                    <i className={`notes-cal-dot notes-cal-dot--${mark.kind}`} />
                    <div className="notes-cal-list__name">
                      {mark.title || t(KIND_LABEL_KEY[mark.kind])}
                      <span className="notes-cal-list__dates">
                        {' · '}
                        {mark.month_days.length > 0
                          ? t('notes.calendar.monthDaysShort', { days: mark.month_days.join(', ') })
                          : mark.weekdays.length > 0
                            ? mark.weekdays.map((d) => t(WEEKDAY_KEYS[d])).join(', ')
                            : t('notes.calendar.modeRange')}
                        {mark.exceptions.length > 0
                          ? ` · ${t('notes.calendar.exceptionsCount', { n: mark.exceptions.length })}`
                          : null}
                      </span>
                    </div>
                  </div>
                  {mark.can_edit ? (
                    <button
                      type="button"
                      className="app-btn app-btn-secondary !min-h-7 !w-7 !px-0 !py-0"
                      onClick={() => void removeMark(mark.id)}
                      aria-label={t('notes.delete')}
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
