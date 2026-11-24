import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type CalendarMark, type DashboardCalendarItem, type NoteColor, type NoteMark } from '../../api'
import { useLocale, useT } from '../../i18n/LocaleContext'

const WEEKDAY_KEYS = [
  'dashboard.calendar.weekdays.mon',
  'dashboard.calendar.weekdays.tue',
  'dashboard.calendar.weekdays.wed',
  'dashboard.calendar.weekdays.thu',
  'dashboard.calendar.weekdays.fri',
  'dashboard.calendar.weekdays.sat',
  'dashboard.calendar.weekdays.sun',
] as const

const PLAN_COLOR_CLASS: Record<NoteColor, string> = {
  blue: 'bg-sky-100 text-sky-900 dark:bg-sky-400/20 dark:text-sky-100',
  green: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-400/20 dark:text-emerald-100',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-400/20 dark:text-amber-100',
  rose: 'bg-rose-100 text-rose-900 dark:bg-rose-400/20 dark:text-rose-100',
  violet: 'bg-violet-100 text-violet-900 dark:bg-violet-400/20 dark:text-violet-100',
  slate: 'bg-slate-200 text-slate-900 dark:bg-slate-400/20 dark:text-slate-100',
}

const DAY_TINT_CLASS: Record<NoteColor, string> = {
  blue: 'bg-sky-50 dark:bg-sky-400/10',
  green: 'bg-emerald-50 dark:bg-emerald-400/10',
  amber: 'bg-amber-50 dark:bg-amber-400/10',
  rose: 'bg-rose-50 dark:bg-rose-400/10',
  violet: 'bg-violet-50 dark:bg-violet-400/10',
  slate: 'bg-slate-100 dark:bg-slate-400/10',
}

const MARK_DOT: Record<NoteColor, string> = {
  blue: 'bg-sky-500',
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
  slate: 'bg-slate-500',
}

const KIND_COLOR: Record<CalendarMark['kind'], NoteColor> = {
  weekend: 'blue',
  holiday: 'rose',
  payday: 'amber',
}

const KIND_KEY = {
  weekend: 'notes.calendar.kinds.weekend',
  holiday: 'notes.calendar.kinds.holiday',
  payday: 'notes.calendar.kinds.payday',
} as const

const MARK_GLYPH: Record<NoteMark, string> = {
  dot: '●',
  flag: '⚑',
  star: '★',
}

function dateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1)
}

function addMonths(value: Date, amount: number): Date {
  return new Date(value.getFullYear(), value.getMonth() + amount, 1)
}

function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

function dateRange(item: DashboardCalendarItem): string[] {
  const start = parseDate(item.start_date)
  const end = parseDate(item.end_date ?? item.start_date)
  const out: string[] = []
  for (const current = new Date(start); current <= end; current.setDate(current.getDate() + 1)) {
    out.push(dateKey(current))
  }
  return out
}

function mondayIndex(value: Date): number {
  return (value.getDay() + 6) % 7
}

function markColor(mark: CalendarMark): NoteColor {
  return mark.color || KIND_COLOR[mark.kind]
}

function expandMarkDays(mark: CalendarMark): string[] {
  const exceptions = new Set(mark.exceptions ?? [])
  const weekdays = mark.weekdays ?? []
  const monthDays = mark.month_days ?? []
  const out: string[] = []
  const end = parseDate(mark.end_date)
  for (const cur = parseDate(mark.start_date); cur <= end; cur.setDate(cur.getDate() + 1)) {
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

function planBadgeClass(item: DashboardCalendarItem): string {
  if (item.kind === 'request') {
    return 'bg-amber-100 text-amber-900 dark:bg-amber-400/20 dark:text-amber-100'
  }
  if (item.color && PLAN_COLOR_CLASS[item.color]) {
    return PLAN_COLOR_CLASS[item.color]
  }
  return 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
}

export function DashboardCalendar({
  compact = false,
  embedded = false,
  plansOnly = false,
  hideNotesLink = false,
  selectedNoteId = null,
  refreshKey = 0,
  onSelectPlan,
}: {
  compact?: boolean
  /** Nested in another panel: no extra card chrome. */
  embedded?: boolean
  /** Notes planner: hide ticket deadlines. */
  plansOnly?: boolean
  hideNotesLink?: boolean
  selectedNoteId?: number | null
  /** Bump after note save so the month grid reloads. */
  refreshKey?: number
  onSelectPlan?: (noteId: number) => void
}) {
  const t = useT()
  const { locale } = useLocale()
  const [month, setMonth] = useState(() => monthStart(new Date()))
  const [items, setItems] = useState<DashboardCalendarItem[]>([])
  const [marks, setMarks] = useState<CalendarMark[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    const from = dateKey(monthStart(month))
    const to = dateKey(new Date(month.getFullYear(), month.getMonth() + 1, 0))
    void Promise.all([
      api.dashboardCalendar(dateKey(month)),
      api.calendarMarks(from, to).catch(() => [] as CalendarMark[]),
    ])
      .then(([next, rules]) => {
        if (cancelled) return
        setItems(plansOnly ? next.filter((item) => item.kind === 'plan') : next)
        setMarks(
          rules.map((row) => ({
            ...row,
            weekdays: row.weekdays ?? [],
            month_days: row.month_days ?? [],
            exceptions: row.exceptions ?? [],
          })),
        )
      })
      .catch(() => {
        if (!cancelled) {
          setItems([])
          setMarks([])
          setFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [month, plansOnly, refreshKey])

  const eventsByDay = useMemo(() => {
    const byDay = new Map<string, DashboardCalendarItem[]>()
    for (const item of items) {
      for (const day of dateRange(item)) {
        const existing = byDay.get(day) ?? []
        existing.push(item)
        byDay.set(day, existing)
      }
    }
    return byDay
  }, [items])

  const marksByDay = useMemo(() => {
    const byDay = new Map<string, CalendarMark[]>()
    for (const mark of marks) {
      for (const day of expandMarkDays(mark)) {
        const existing = byDay.get(day) ?? []
        existing.push(mark)
        byDay.set(day, existing)
      }
    }
    return byDay
  }, [marks])

  const days = useMemo(() => {
    const start = monthStart(month)
    const leading = (start.getDay() + 6) % 7
    const gridStart = new Date(start)
    gridStart.setDate(start.getDate() - leading)
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(gridStart)
      date.setDate(gridStart.getDate() + index)
      return date
    })
  }, [month])

  const monthLabel = new Intl.DateTimeFormat(locale === 'ru' ? 'ru-RU' : 'en-US', {
    month: 'long',
    year: 'numeric',
  }).format(month)
  const today = dateKey(new Date())

  return (
    <section
      className={
        embedded
          ? 'min-w-0'
          : `app-panel min-w-0 !rounded-xl ${compact ? '!p-2.5' : '!p-3.5 sm:!p-4'}`
      }
      aria-label={compact ? t('dashboard.calendar.title') : undefined}
      aria-labelledby={compact ? undefined : 'dashboard-calendar-title'}
    >
      {!compact ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div
              id="dashboard-calendar-title"
              className="text-[13px] font-semibold text-[var(--color-fg-subtle)]"
            >
              {t('dashboard.calendar.title')}
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-subtle)]">
              {plansOnly ? t('dashboard.calendar.notesHint') : t('dashboard.calendar.hint')}
            </p>
          </div>
          {!hideNotesLink ? (
            <Link
              to="/knowledge-base/notes"
              className="shrink-0 text-[11px] font-medium text-[var(--color-primary)] no-underline hover:underline"
            >
              {t('dashboard.calendar.openPlanner')}
            </Link>
          ) : null}
        </div>
      ) : null}

      <div className={`${compact ? 'mb-1.5' : 'mb-2'} flex items-center justify-between gap-2`}>
        <button
          type="button"
          className="app-btn app-btn-secondary !min-h-[28px] !w-7 !px-0 !py-0"
          onClick={() => setMonth((value) => addMonths(value, -1))}
          aria-label={t('dashboard.calendar.previousMonth')}
        >
          <span
            aria-hidden
            className="ml-[-1px] h-0 w-0 border-y-[4px] border-y-transparent border-r-[6px] border-r-[var(--color-fg-muted)]"
          />
        </button>
        <div className="text-sm font-semibold capitalize text-[var(--color-fg)]">{monthLabel}</div>
        <button
          type="button"
          className="app-btn app-btn-secondary !min-h-[28px] !w-7 !px-0 !py-0"
          onClick={() => setMonth((value) => addMonths(value, 1))}
          aria-label={t('dashboard.calendar.nextMonth')}
        >
          <span
            aria-hidden
            className="mr-[-1px] h-0 w-0 border-y-[4px] border-y-transparent border-l-[6px] border-l-[var(--color-fg-muted)]"
          />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-border)]">
        {WEEKDAY_KEYS.map((key) => (
          <div
            key={key}
            className={`bg-[var(--color-surface-muted)] px-1 text-center text-[10px] font-semibold text-[var(--color-fg-subtle)] ${compact ? 'py-1' : 'py-1.5'}`}
          >
            {t(key)}
          </div>
        ))}
        {days.map((day) => {
          const key = dateKey(day)
          const inMonth = day.getMonth() === month.getMonth()
          const events = eventsByDay.get(key) ?? []
          const dayMarks = marksByDay.get(key) ?? []
          const visible = events.slice(0, compact ? 1 : 3)
          const tintColor = events.find((e) => e.kind === 'plan' && e.color)?.color
          const ruleColor = dayMarks[0] ? markColor(dayMarks[0]) : undefined
          const mark = events.find((e) => e.kind === 'plan' && e.mark)?.mark
          const dayTint = tintColor
            ? DAY_TINT_CLASS[tintColor]
            : ruleColor
              ? DAY_TINT_CLASS[ruleColor]
              : 'bg-[var(--color-surface)]'
          const ruleTitle = dayMarks
            .map((rule) => rule.title.trim() || t(KIND_KEY[rule.kind]))
            .join(', ')
          return (
            <div
              key={key}
              className={`${compact ? 'min-h-[2.65rem] p-0.5' : 'min-h-[5.75rem] p-1'} ${dayTint} ${inMonth ? '' : 'opacity-45'}`}
              title={ruleTitle || undefined}
            >
              <div className="mb-0.5 flex items-center justify-between gap-0.5">
                <div
                  className={`${compact ? 'h-4 w-4 text-[9px]' : 'h-5 w-5 text-[10px]'} flex items-center justify-center rounded-full font-semibold ${
                    key === today
                      ? 'bg-[var(--color-primary)] text-white'
                      : 'text-[var(--color-fg-muted)]'
                  }`}
                >
                  {day.getDate()}
                </div>
                {dayMarks.length > 0 ? (
                  <span className="flex items-center gap-px" aria-hidden>
                    {dayMarks.slice(0, 3).map((rule) => (
                      <i
                        key={rule.id}
                        className={`inline-block h-1.5 w-1.5 rounded-full ${MARK_DOT[markColor(rule)]}`}
                      />
                    ))}
                  </span>
                ) : mark ? (
                  <span
                    className={`${compact ? 'text-[8px]' : 'text-[10px]'} leading-none text-[var(--color-fg-muted)]`}
                    title={t(`dashboard.calendar.marks.${mark}`)}
                    aria-hidden
                  >
                    {MARK_GLYPH[mark]}
                  </span>
                ) : null}
              </div>
              <div className={compact ? 'space-y-0' : 'space-y-0.5'}>
                {(compact && events.length > 0 ? [] : dayMarks.slice(0, compact ? 1 : 2)).map((rule) => (
                  <div
                    key={`rule-${rule.id}`}
                    title={rule.title.trim() || t(KIND_KEY[rule.kind])}
                    className={`block truncate rounded px-1 font-medium ${compact ? 'py-px text-[8px]' : 'py-0.5 text-[9px]'} ${PLAN_COLOR_CLASS[markColor(rule)]}`}
                  >
                    {rule.title.trim() || t(KIND_KEY[rule.kind])}
                  </div>
                ))}
                {visible.map((item, index) => {
                  const selected = item.kind === 'plan' && selectedNoteId === item.id
                  const className = `block truncate rounded px-1 ${compact ? 'py-px text-[8px]' : 'py-0.5 text-[9px]'} font-medium no-underline ${planBadgeClass(item)} ${
                    selected ? 'ring-1 ring-[var(--color-fg)]/40' : ''
                  }`
                  const label = `${item.kind === 'plan' ? t('dashboard.calendar.planPrefix') : t('dashboard.calendar.requestPrefix')} ${item.title}`
                  if (item.kind === 'plan' && onSelectPlan) {
                    return (
                      <button
                        key={`${item.kind}-${item.id}-${index}`}
                        type="button"
                        title={item.title}
                        className={`${className} w-full text-left`}
                        onClick={() => onSelectPlan(item.id)}
                      >
                        {label}
                      </button>
                    )
                  }
                  return (
                    <Link
                      key={`${item.kind}-${item.id}-${index}`}
                      to={item.kind === 'plan' ? `/knowledge-base/notes?id=${item.id}` : `/requests/database`}
                      title={item.title}
                      className={className}
                    >
                      {label}
                    </Link>
                  )
                })}
                {events.length > visible.length ? (
                  <div className="px-1 text-xs font-medium text-[var(--color-fg-subtle)]">
                    {t('dashboard.calendar.more', { count: events.length - visible.length })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {compact && !hideNotesLink ? (
        <div className="mt-1.5 text-right">
          <Link
            to="/knowledge-base/notes"
            className="text-[10px] font-medium text-[var(--color-primary)] no-underline hover:underline"
          >
            {t('dashboard.calendar.openNotes')}
          </Link>
        </div>
      ) : null}
      {!compact && loading ? <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">{t('common.loading')}</p> : null}
      {!compact && failed ? (
        <p className="mt-2 text-xs text-[var(--color-error-fg)]">{t('dashboard.calendar.error')}</p>
      ) : null}
      {!compact && !loading && !failed && items.length === 0 && marks.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">{t('dashboard.calendar.empty')}</p>
      ) : null}
    </section>
  )
}
