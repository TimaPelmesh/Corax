import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  api,
  type RiskHistoryPoint,
  type RiskOverview,
  type RiskProblemGroup,
} from '../api'
import { useAuth } from '../AuthContext'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { MiniStatCard } from '../components/dashboard/DashboardWidgets'
import { IconActivity, IconCheckBadge, IconLock, IconPcs, IconSignal } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { Skeleton, StatRowSkeleton } from '../components/Skeleton'
import { useLocale } from '../i18n/LocaleContext'
import { useToast } from '../ToastContext'
import {
  countByFindingStatus,
  filterRiskProblems,
  groupStatus,
  healthStroke,
  severityDot,
  severityTone,
  type FindingFilter,
  type SeverityFilter,
} from './riskCenterModel'

const COPY = {
  ru: {
    title: 'Центр рисков',
    subtitle: 'Актуальные проблемы парка: антивирус, обновления Windows, диски и остальные правила',
    loading: 'Анализируем состояние парка…',
    health: 'Здоровье парка',
    healthHint: 'Чем выше, тем меньше подтверждённых рисков',
    critical: 'Критические',
    high: 'Высокий риск',
    medium: 'Требуют внимания',
    low: 'Низкий',
    healthy: 'Без заметных рисков',
    problems: 'Актуальные проблемы',
    problemsHint:
      'Сортировка по типу проблемы, не по компьютеру. Игнор действует на весь тип — новые ПК с той же проблемой тоже скрываются.',
    search: 'Поиск по проблеме или компьютеру',
    all: 'Все уровни',
    noItems: 'По выбранному фильтру ничего не найдено',
    recommendation: 'Что сделать',
    score: 'вес',
    pcs: 'ПК',
    openFleet: 'Открыть парк',
    updated: 'Рассчитано',
    total: 'Всего ПК',
    antivirus: 'Антивирус подтверждён',
    antivirusAttention: 'Антивирус требует внимания',
    antivirusUnknown: 'Нет данных об антивирусе',
    history: 'История здоровья парка',
    historyHint: 'Снимки оценки. Подтверждённые и игнорируемые проблемы не снижают балл.',
    historyEmpty: 'История появится после нескольких расчётов.',
    historyScore: 'здоровье',
    openFindings: 'Открытые',
    acknowledged: 'Подтверждённые',
    ignored: 'Игнорируемые',
    acknowledge: 'Подтвердить проблему',
    ignore: 'Игнорировать проблему',
    reopen: 'Вернуть проблему',
    actionBusy: 'Сохраняем…',
    actionSaved: 'Статус проблемы обновлён',
    openComputer: 'Открыть карточку ПК',
    createTicket: 'Создать заявку',
    ticketBusy: 'Создаём заявку…',
    ticketDone: 'Заявка №{id} создана',
    ticketFailed: 'Не удалось создать заявку',
    showPcs: 'Показать компьютеры',
    hidePcs: 'Скрыть компьютеры',
    managedHint: 'Игнор относится к конкретной проблеме во всём парке, а не к одному ПК.',
  },
  en: {
    title: 'Risk center',
    subtitle: 'Live fleet problems: antivirus, Windows updates, disks, and the rest of the rules',
    loading: 'Analyzing fleet health…',
    health: 'Fleet health',
    healthHint: 'Higher means fewer confirmed risks',
    critical: 'Critical',
    high: 'High risk',
    medium: 'Needs attention',
    low: 'Low',
    healthy: 'No notable risks',
    problems: 'Current problems',
    problemsHint:
      'Grouped by problem type, not by computer. Ignoring a type hides it fleet-wide, including new PCs with the same issue.',
    search: 'Search problem or computer',
    all: 'All levels',
    noItems: 'Nothing matches the selected filter',
    recommendation: 'Recommended action',
    score: 'weight',
    pcs: 'PCs',
    openFleet: 'Open fleet',
    updated: 'Calculated',
    total: 'Total computers',
    antivirus: 'Antivirus confirmed',
    antivirusAttention: 'Antivirus needs attention',
    antivirusUnknown: 'No antivirus data',
    history: 'Fleet health history',
    historyHint: 'Score snapshots. Acknowledged and ignored problems do not reduce the score.',
    historyEmpty: 'History will appear after a few calculations.',
    historyScore: 'health',
    openFindings: 'Open',
    acknowledged: 'Acknowledged',
    ignored: 'Ignored',
    acknowledge: 'Acknowledge problem',
    ignore: 'Ignore problem',
    reopen: 'Reopen problem',
    actionBusy: 'Saving…',
    actionSaved: 'Problem status updated',
    openComputer: 'Open computer card',
    createTicket: 'Create ticket',
    ticketBusy: 'Creating ticket…',
    ticketDone: 'Ticket #{id} created',
    ticketFailed: 'Could not create the ticket',
    showPcs: 'Show computers',
    hidePcs: 'Hide computers',
    managedHint: 'Ignore applies to this problem across the fleet, not to a single PC.',
  },
} as const

function RiskSkeleton({ text }: { text: string }) {
  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4" role="status" aria-busy="true">
      <span className="sr-only">{text}</span>
      <div className="grid gap-3 xl:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
        <Skeleton className="h-[8.5rem] rounded-[var(--radius-lg)]" />
        <StatRowSkeleton count={6} />
      </div>
      <Skeleton className="h-40 rounded-[var(--radius-lg)]" />
      <Skeleton className="h-64 rounded-[var(--radius-lg)]" />
    </div>
  )
}

function HealthRing({ score }: { score: number }) {
  const clamped = Math.min(100, Math.max(0, score))
  const radius = 46
  const circ = 2 * Math.PI * radius
  const offset = circ * (1 - clamped / 100)
  return (
    <svg viewBox="0 0 120 120" className="h-[7.25rem] w-[7.25rem]" aria-hidden>
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        strokeWidth="10"
        className="stroke-[var(--color-surface-muted)]"
      />
      <circle
        cx="60"
        cy="60"
        r={radius}
        fill="none"
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        transform="rotate(-90 60 60)"
        className={healthStroke(clamped)}
      />
      <text
        x="60"
        y="58"
        textAnchor="middle"
        fontSize="28"
        fontWeight="600"
        className="fill-[var(--color-fg)]"
      >
        {clamped}
      </text>
      <text x="60" y="78" textAnchor="middle" fontSize="11" className="fill-[var(--color-fg-subtle)]">
        / 100
      </text>
    </svg>
  )
}

function HistoryChart({ items, label }: { items: RiskHistoryPoint[]; label: string }) {
  if (items.length === 0) return null
  const width = 720
  const height = 128
  const padX = 8
  const padY = 10
  const maxScore = 100
  const xs = items.map((_, index) =>
    items.length === 1 ? width / 2 : padX + (index / (items.length - 1)) * (width - padX * 2),
  )
  const ys = items.map(
    (point) => height - padY - (Math.min(maxScore, Math.max(0, point.fleet_health_score)) / maxScore) * (height - padY * 2),
  )
  const line = xs.map((x, index) => `${x.toFixed(1)},${ys[index].toFixed(1)}`).join(' ')
  const area = `${padX},${height - padY} ${line} ${width - padX},${height - padY}`
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-32 w-full" aria-label={label} preserveAspectRatio="none">
      <defs>
        <linearGradient id="risk-health-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#risk-health-fill)" />
      <polyline
        points={line}
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth="2.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function RiskCenterPage() {
  const { locale } = useLocale()
  const { user } = useAuth()
  const c = locale === 'ru' ? COPY.ru : COPY.en
  const toast = useToast()
  const [overview, setOverview] = useState<RiskOverview | null>(null)
  const [history, setHistory] = useState<RiskHistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [severity, setSeverity] = useState<SeverityFilter>('all')
  const [query, setQuery] = useState('')
  const [findingFilter, setFindingFilter] = useState<FindingFilter>('open')
  const [detailComputerId, setDetailComputerId] = useState<number | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [expandedRule, setExpandedRule] = useState<string | null>(null)
  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')
  const navigate = useNavigate()
  const [ticketId, setTicketId] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    const [nextOverview, nextHistory] = await Promise.all([
      api.riskOverview(),
      api.riskHistory(90).catch(() => ({ items: [] as RiskHistoryPoint[] })),
    ])
    setOverview(nextOverview)
    setHistory(nextHistory.items)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void loadOverview()
      .catch((error) => {
        if (!cancelled) toast.error(error instanceof Error ? error.message : 'Risk analysis failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadOverview, toast])

  const problemGroups = overview?.problem_groups ?? []

  const statusCounts = useMemo(() => countByFindingStatus(problemGroups), [problemGroups])

  const filteredProblems = useMemo(
    () => filterRiskProblems(problemGroups, { findingFilter, severity, query }),
    [findingFilter, problemGroups, query, severity],
  )

  async function createTicket(group: RiskProblemGroup) {
    if (!canManage || ticketId) return
    setTicketId(group.finding_id)
    const hosts = group.computers.slice(0, 12).map((pc) => pc.hostname).filter(Boolean)
    const extra = group.computers.length > hosts.length ? ` (+${group.computers.length - hosts.length})` : ''
    const priority = group.severity === 'critical' || group.severity === 'high' ? 'high' : group.severity === 'low' ? 'low' : 'normal'
    try {
      const row = await api.createServiceRequest({
        title: group.title.slice(0, 255),
        description: [group.description, group.recommendation, hosts.length ? `${c.pcs}: ${hosts.join(', ')}${extra}` : '']
          .filter(Boolean)
          .join('\n\n'),
        priority,
        status: 'open',
        computer_id: group.computers.length === 1 ? group.computers[0].id : null,
      })
      toast.ok(c.ticketDone.replace('{id}', String(row.id)))
      navigate(`/requests/database?edit=${row.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : c.ticketFailed)
    } finally {
      setTicketId(null)
    }
  }

  async function applyProblemAction(group: RiskProblemGroup, status: FindingFilter) {
    if (!canManage) return
    setActionId(group.finding_id)
    try {
      await api.riskFindingAction({ finding_id: group.finding_id, status })
      await loadOverview()
      toast.ok(c.actionSaved)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Risk action failed')
    } finally {
      setActionId(null)
    }
  }

  if (loading) return <RiskSkeleton text={c.loading} />
  if (!overview) return null

  const antivirusPercent = overview.computers_total
    ? Math.round((overview.antivirus_protected / overview.computers_total) * 100)
    : 0
  const latestHistory = history.at(-1)
  const previousHistory = history.length > 1 ? history.at(-2) : undefined
  const healthDelta =
    latestHistory && previousHistory
      ? latestHistory.fleet_health_score - previousHistory.fleet_health_score
      : null

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4">
      <PageHeader title={c.title} subtitle={c.subtitle} />

      <section className="risk-card-enter grid gap-3 xl:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
        <div className="app-panel flex items-center gap-4">
          <HealthRing score={overview.fleet_health_score} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-[var(--color-fg-subtle)]">{c.health}</div>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">{c.healthHint}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {healthDelta != null ? (
                <span className="rounded-full bg-[var(--color-info-bg)] px-2 py-0.5 font-semibold text-[var(--color-info-fg)]">
                  {healthDelta > 0 ? `+${healthDelta}` : healthDelta}
                </span>
              ) : null}
              <span className="text-[var(--color-fg-subtle)]">
                {c.updated} · {new Date(overview.generated_at).toLocaleString()}
              </span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <MiniStatCard
            label={c.total}
            value={overview.computers_total}
            sub={c.openFleet}
            icon={<IconPcs className="h-4 w-4" />}
            to="/computers"
          />
          <MiniStatCard
            label={c.problems}
            value={statusCounts.open}
            sub={`${c.critical}: ${overview.computers_critical}`}
            icon={<IconActivity className="h-4 w-4" />}
          />
          <MiniStatCard
            label={c.antivirus}
            value={`${antivirusPercent}%`}
            sub={`${overview.antivirus_protected}/${overview.computers_total}`}
            icon={<IconCheckBadge className="h-4 w-4" />}
          />
          <MiniStatCard
            label={c.antivirusAttention}
            value={overview.antivirus_attention}
            sub={`${c.antivirusUnknown}: ${overview.antivirus_unknown}`}
            icon={<IconSignal className="h-4 w-4" />}
          />
          <MiniStatCard
            label={c.critical}
            value={overview.computers_critical}
            sub={`${c.high}: ${overview.computers_high}`}
            icon={<IconLock className="h-4 w-4" />}
          />
          <MiniStatCard
            label={c.healthy}
            value={overview.computers_healthy}
            sub={`${c.medium}: ${overview.computers_medium}`}
            icon={<IconCheckBadge className="h-4 w-4" />}
          />
        </div>
      </section>

      <section className="risk-card-enter app-panel">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-semibold text-[var(--color-fg)]">{c.history}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{c.historyHint}</p>
          </div>
          {latestHistory ? (
            <div className="text-xs text-[var(--color-fg-muted)]">
              {c.historyScore}: <strong className="text-[var(--color-fg)]">{latestHistory.fleet_health_score}</strong>
              {' · '}
              {c.openFindings}: <strong className="text-[var(--color-fg)]">{latestHistory.findings_open}</strong>
            </div>
          ) : null}
        </div>
        {history.length > 0 ? (
          <HistoryChart items={history} label={c.history} />
        ) : (
          <p className="text-sm text-[var(--color-fg-muted)]">{c.historyEmpty}</p>
        )}
      </section>

      <section className="risk-card-enter app-card overflow-hidden p-0">
        <div className="flex flex-col gap-3 border-b border-[var(--color-border)] p-4 sm:p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold text-[var(--color-fg)]">{c.problems}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{c.problemsHint}</p>
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <input
              className="app-input w-full min-w-0 sm:min-w-[16rem]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={c.search}
            />
            <select
              className="app-input app-select w-full sm:w-44"
              value={severity}
              onChange={(event) => setSeverity(event.target.value as SeverityFilter)}
            >
              <option value="all">{c.all}</option>
              <option value="critical">{c.critical}</option>
              <option value="high">{c.high}</option>
              <option value="medium">{c.medium}</option>
              <option value="low">{c.low}</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
          {(
            [
              ['open', c.openFindings, statusCounts.open],
              ['acknowledged', c.acknowledged, statusCounts.acknowledged],
              ['ignored', c.ignored, statusCounts.ignored],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                findingFilter === id
                  ? 'bg-[var(--color-primary)] text-white'
                  : 'bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
              }`}
              onClick={() => setFindingFilter(id)}
            >
              {label} · {count}
            </button>
          ))}
          <Link
            to="/computers"
            className="ml-auto text-sm font-medium text-[var(--color-primary)] no-underline hover:underline"
          >
            {c.openFleet}
          </Link>
        </div>
        <p className="px-4 pt-3 text-xs text-[var(--color-fg-muted)] sm:px-5">{c.managedHint}</p>
        <div className="divide-y divide-[var(--color-border)]">
          {filteredProblems.map((group) => {
            const expanded = expandedRule === group.rule
            return (
              <article key={group.rule} className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-xl px-1 text-left transition hover:bg-[var(--color-surface-muted)]/70"
                    onClick={() => setExpandedRule(expanded ? null : group.rule)}
                    aria-expanded={expanded}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${severityDot[group.severity]}`} />
                      <h3 className="font-semibold text-[var(--color-fg)]">{group.title}</h3>
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${severityTone[group.severity]}`}
                      >
                        {group.severity === 'critical'
                          ? c.critical
                          : group.severity === 'high'
                            ? c.high
                            : group.severity === 'medium'
                              ? c.medium
                              : c.low}
                        {' · '}
                        {group.affected_computers} {c.pcs}
                      </span>
                      <svg
                        viewBox="0 0 20 20"
                        className={`h-3.5 w-3.5 text-[var(--color-fg-subtle)] transition ${expanded ? 'rotate-180' : ''}`}
                        fill="currentColor"
                        aria-hidden
                      >
                        <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.94l3.71-3.71a.75.75 0 1 1 1.06 1.06l-4.24 4.25a.75.75 0 0 1-1.06 0L5.21 8.29a.75.75 0 0 1 .02-1.08Z" />
                      </svg>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-fg-muted)]">{group.description}</p>
                    <div className="mt-2 text-xs font-medium text-[var(--color-primary)]">
                      {expanded ? c.hidePcs : c.showPcs}
                    </div>
                  </button>
                  <div className="flex w-full shrink-0 flex-col items-stretch gap-2 lg:w-auto lg:max-w-sm lg:items-end">
                    <div className="rounded-lg border border-[var(--color-info-border)] bg-[var(--color-info-bg)] px-3 py-2 text-xs leading-relaxed text-[var(--color-info-fg)]">
                      <strong>{c.recommendation}:</strong> {group.recommendation}
                    </div>
                    {canManage ? (
                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        <button
                          type="button"
                          className="app-btn app-btn-primary w-full !min-h-8 !px-2.5 !py-1 !text-xs sm:w-auto"
                          disabled={ticketId === group.finding_id || actionId === group.finding_id}
                          onClick={() => void createTicket(group)}
                        >
                          {ticketId === group.finding_id ? c.ticketBusy : c.createTicket}
                        </button>
                        {groupStatus(group) === 'open' ? (
                          <>
                            <button
                              type="button"
                              className="app-btn app-btn-secondary w-full !min-h-8 !px-2.5 !py-1 !text-xs sm:w-auto"
                              disabled={actionId === group.finding_id}
                              onClick={() => void applyProblemAction(group, 'acknowledged')}
                            >
                              {actionId === group.finding_id ? c.actionBusy : c.acknowledge}
                            </button>
                            <button
                              type="button"
                              className="app-btn app-btn-secondary w-full !min-h-8 !px-2.5 !py-1 !text-xs sm:w-auto"
                              disabled={actionId === group.finding_id}
                              onClick={() => void applyProblemAction(group, 'ignored')}
                            >
                              {c.ignore}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="app-btn app-btn-secondary w-full !min-h-8 !px-2.5 !py-1 !text-xs sm:w-auto"
                            disabled={actionId === group.finding_id}
                            onClick={() => void applyProblemAction(group, 'open')}
                          >
                            {actionId === group.finding_id ? c.actionBusy : c.reopen}
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
                {expanded ? (
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {group.computers.map((pc) => (
                      <li key={pc.finding_id}>
                        <button
                          type="button"
                          className="w-full rounded-lg border border-[var(--color-border)] px-3 py-2 text-left text-sm hover:bg-[var(--color-bg-muted)]/60"
                          onClick={() => setDetailComputerId(pc.id)}
                          title={c.openComputer}
                        >
                          <div className="font-medium text-[var(--color-fg)]">{pc.hostname}</div>
                          <div className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                            {[pc.ip_address, pc.os_name, pc.evidence].filter(Boolean).join(' · ') || '—'}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            )
          })}
          {filteredProblems.length === 0 ? (
            <div className="app-empty-state !rounded-none border-0">{c.noItems}</div>
          ) : null}
        </div>
      </section>

      {detailComputerId != null ? (
        <ComputerDetailModal computerId={detailComputerId} onClose={() => setDetailComputerId(null)} />
      ) : null}
    </div>
  )
}
