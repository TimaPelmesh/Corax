import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type DashboardCalendarItem } from '../../api'
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

export function DashboardCalendar({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const { locale } = useLocale()
  const [month, setMonth] = useState(() => monthStart(new Date()))
  const [items, setItems] = useState<DashboardCalendarItem[]>([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    void api
      .dashboardCalendar(dateKey(month))
      .then((next) => {
        if (!cancelled) setItems(next)
      })
      .catch(() => {
        if (!cancelled) {
          setItems([])
          setFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [month])

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
      className={`app-panel min-w-0 !rounded-xl ${compact ? '!p-2.5' : '!p-3.5 sm:!p-4'}`}
      aria-label={compact ? t('dashboard.calendar.title') : undefined}
      aria-labelledby={compact ? undefined : 'dashboard-calendar-title'}
    >
      {!compact ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <div id="dashboard-calendar-title" className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-fg-subtle)]">
              {t('dashboard.calendar.title')}
            </div>
            <p className="mt-0.5 text-[11px] text-[var(--color-fg-subtle)]">{t('dashboard.calendar.hint')}</p>
          </div>
          <Link to="/knowledge-base/notes" className="shrink-0 text-[11px] font-medium text-[var(--color-primary)] no-underline hover:underline">
            {t('dashboard.calendar.openPlanner')}
          </Link>
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
          <div key={key} className={`bg-[var(--color-surface-muted)] px-1 text-center text-[10px] font-semibold text-[var(--color-fg-subtle)] ${compact ? 'py-1' : 'py-1.5'}`}>
            {t(key)}
          </div>
        ))}
        {days.map((day) => {
          const key = dateKey(day)
          const inMonth = day.getMonth() === month.getMonth()
          const events = eventsByDay.get(key) ?? []
          const visible = events.slice(0, compact ? 1 : 3)
          return (
            <div
              key={key}
              className={`${compact ? 'min-h-[2.65rem] p-0.5' : 'min-h-[5.75rem] p-1'} bg-[var(--color-surface)] ${inMonth ? '' : 'opacity-45'}`}
            >
              <div className={`${compact ? 'mb-0 h-4 w-4 text-[9px]' : 'mb-1 h-5 w-5 text-[10px]'} flex items-center justify-center rounded-full font-semibold ${key === today ? 'bg-[var(--color-primary)] text-white' : 'text-[var(--color-fg-muted)]'}`}>
                {day.getDate()}
              </div>
              <div className={compact ? 'space-y-0' : 'space-y-0.5'}>
                {visible.map((item, index) => (
                  <Link
                    key={`${item.kind}-${item.id}-${index}`}
                    to={item.kind === 'plan' ? `/knowledge-base/notes?id=${item.id}` : `/requests/database`}
                    title={item.title}
                    className={`block truncate rounded px-1 ${compact ? 'py-px text-[8px]' : 'py-0.5 text-[9px]'} font-medium no-underline ${
                      item.kind === 'plan'
                        ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
                        : 'bg-amber-100 text-amber-900 dark:bg-amber-400/20 dark:text-amber-100'
                    }`}
                  >
                    {item.kind === 'plan' ? t('dashboard.calendar.planPrefix') : t('dashboard.calendar.requestPrefix')} {item.title}
                  </Link>
                ))}
                {events.length > visible.length ? (
                  <div className="px-1 text-[9px] font-medium text-[var(--color-fg-subtle)]">
                    {t('dashboard.calendar.more', { count: events.length - visible.length })}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
      </div>

      {compact ? (
        <div className="mt-1.5 text-right">
          <Link to="/knowledge-base/notes" className="text-[10px] font-medium text-[var(--color-primary)] no-underline hover:underline">
            {t('dashboard.calendar.openNotes')}
          </Link>
        </div>
      ) : null}
      {!compact && loading ? <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">{t('common.loading')}</p> : null}
      {!compact && failed ? <p className="mt-2 text-xs text-[var(--color-error-fg)]">{t('dashboard.calendar.error')}</p> : null}
      {!compact && !loading && !failed && items.length === 0 ? <p className="mt-2 text-xs text-[var(--color-fg-subtle)]">{t('dashboard.calendar.empty')}</p> : null}
    </section>
  )
}
