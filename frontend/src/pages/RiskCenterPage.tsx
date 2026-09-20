import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type RiskAiInsight,
  type RiskHistoryPoint,
  type RiskOverview,
  type RiskProblemGroup,
} from '../api'
import { useAuth } from '../AuthContext'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { MiniStatCard } from '../components/dashboard/DashboardWidgets'
import { IconActivity, IconCheckBadge, IconLock, IconPcs, IconSignal } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useLocale } from '../i18n/LocaleContext'
import { loadWikiRagLmSettings } from '../lib/wikiragLmSettings'
import { useToast } from '../ToastContext'

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
    aiTitle: 'Инсайты локального AI',
    aiRun: 'Проанализировать',
    aiRefresh: 'Обновить анализ',
    aiBusy: 'Модель анализирует…',
    aiEmpty: 'Запустите анализ, чтобы получить приоритеты и связи между проблемами.',
    aiPermission: 'Запуск доступен редакторам и администраторам.',
    categories: 'Откуда складывается риск',
    affected: 'ПК затронуто',
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
    aiTitle: 'Local AI insights',
    aiRun: 'Analyze',
    aiRefresh: 'Refresh analysis',
    aiBusy: 'Model is analyzing…',
    aiEmpty: 'Run analysis to discover priorities and relationships between issues.',
    aiPermission: 'Editors and administrators can run the analysis.',
    categories: 'Risk composition',
    affected: 'computers affected',
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
    showPcs: 'Show computers',
    hidePcs: 'Hide computers',
    managedHint: 'Ignore applies to this problem across the fleet, not to a single PC.',
  },
} as const

type FindingFilter = 'open' | 'acknowledged' | 'ignored'
type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low'

const severityTone: Record<RiskProblemGroup['severity'], string> = {
  critical: 'border-blue-600/40 bg-blue-600/15 text-blue-800 dark:text-blue-200',
  high: 'border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-200',
  medium: 'border-blue-400/30 bg-blue-400/10 text-blue-700 dark:text-blue-300',
  low: 'border-blue-300/25 bg-blue-300/10 text-blue-600 dark:text-blue-300',
}

const severityDot: Record<RiskProblemGroup['severity'], string> = {
  critical: 'bg-blue-800 dark:bg-blue-300',
  high: 'bg-blue-600 dark:bg-blue-400',
  medium: 'bg-blue-400 dark:bg-blue-500',
  low: 'bg-blue-300 dark:bg-blue-600',
}

function groupStatus(group: RiskProblemGroup): FindingFilter {
  return group.status === 'acknowledged' || group.status === 'ignored' ? group.status : 'open'
}

function RiskSkeleton({ text }: { text: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-blue-100 border-t-blue-600" />
      <p className="text-sm text-[var(--color-fg-muted)]">{text}</p>
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
        className="stroke-blue-600 dark:stroke-blue-400"
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
          <stop offset="0%" stopColor="rgb(37 99 235)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="rgb(37 99 235)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#risk-health-fill)" />
      <polyline points={line} fill="none" stroke="rgb(37 99 235)" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
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
  const [aiInsight, setAiInsight] = useState<RiskAiInsight | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [detailComputerId, setDetailComputerId] = useState<number | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
  const [expandedRule, setExpandedRule] = useState<string | null>(null)
  const canManage = Boolean(user?.is_superuser || user?.role === 'editor')
  const canRunAi = canManage

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

  const statusCounts = useMemo(() => {
    const counts = { open: 0, acknowledged: 0, ignored: 0 }
    for (const group of problemGroups) {
      counts[groupStatus(group)] += 1
    }
    return counts
  }, [problemGroups])

  const filteredProblems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return problemGroups.filter((group) => {
      if (groupStatus(group) !== findingFilter) return false
      if (severity !== 'all' && group.severity !== severity) return false
      if (!q) return true
      return (
        group.title.toLowerCase().includes(q) ||
        group.description.toLowerCase().includes(q) ||
        group.rule.toLowerCase().includes(q) ||
        group.computers.some(
          (pc) =>
            pc.hostname.toLowerCase().includes(q) ||
            (pc.ip_address || '').toLowerCase().includes(q) ||
            (pc.os_name || '').toLowerCase().includes(q),
        )
      )
    })
  }, [findingFilter, problemGroups, query, severity])

  async function runAi(force: boolean) {
    setAiBusy(true)
    try {
      const settings = loadWikiRagLmSettings()
      const result = await api.riskAiInsights({
        base_url: settings.baseUrl,
        model: settings.model || undefined,
        response_mode: settings.responseMode,
        force,
      })
      setAiInsight(result)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Local AI is unavailable')
    } finally {
      setAiBusy(false)
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

  const maxCategoryPoints = Math.max(1, ...overview.categories.map((item) => item.risk_points))
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
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5 sm:px-6">
      <PageHeader icon={<IconLock className="h-7 w-7" />} title={c.title} subtitle={c.subtitle} />

      <section className="risk-card-enter grid gap-3 xl:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)]">
        <div className="app-panel flex items-center gap-4 !rounded-2xl !p-5">
          <HealthRing score={overview.fleet_health_score} />
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg-subtle)]">
              {c.health}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-fg-muted)]">{c.healthHint}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              {healthDelta != null ? (
                <span className="rounded-full bg-blue-600/10 px-2 py-0.5 font-semibold text-blue-800 dark:text-blue-200">
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

      <section className="risk-card-enter app-panel !rounded-2xl !p-5">
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

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(22rem,0.9fr)]">
        <div className="risk-card-enter app-panel !rounded-2xl !p-5">
          <div className="mb-4 flex items-center gap-2">
            <IconActivity className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <h2 className="font-semibold text-[var(--color-fg)]">{c.categories}</h2>
          </div>
          <div className="space-y-4">
            {overview.categories.map((category) => (
              <div key={category.id}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-[var(--color-fg)]">{category.label}</span>
                  <span className="text-xs tabular-nums text-[var(--color-fg-muted)]">
                    {category.affected_computers} {c.affected}
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-600 to-sky-400 transition-[width] duration-700 ease-out"
                    style={{ width: `${Math.max(4, (category.risk_points / maxCategoryPoints) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="risk-card-enter app-panel !rounded-2xl !p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <IconCheckBadge className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                <h2 className="font-semibold text-[var(--color-fg)]">{c.aiTitle}</h2>
              </div>
              {!canRunAi ? (
                <p className="mt-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">{c.aiPermission}</p>
              ) : null}
            </div>
            <button
              type="button"
              className="app-btn app-btn-primary shrink-0 !min-h-[2.5rem] !px-3 !text-sm"
              disabled={aiBusy || !canRunAi}
              onClick={() => void runAi(Boolean(aiInsight))}
            >
              {aiBusy ? c.aiBusy : aiInsight ? c.aiRefresh : c.aiRun}
            </button>
          </div>
          <div className="mt-4 min-h-36 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 text-sm leading-6 text-[var(--color-fg)]">
            {aiInsight ? (
              <div className="whitespace-pre-wrap">{aiInsight.text}</div>
            ) : (
              <div className="flex min-h-24 items-center text-[var(--color-fg-muted)]">{c.aiEmpty}</div>
            )}
            {aiInsight?.model ? (
              <div className="mt-3 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-fg-subtle)]">
                {aiInsight.model}
                {aiInsight.cached ? ' · cache' : ''}
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="risk-card-enter overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex flex-col gap-3 border-b border-[var(--color-border)] p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold text-[var(--color-fg)]">{c.problems}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{c.problemsHint}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="app-input min-w-[16rem]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={c.search}
            />
            <select
              className="app-input sm:w-44"
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
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] px-5 py-3">
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
              className={`rounded-full px-3 py-1.5 text-xs font-semibold ring-1 transition ${
                findingFilter === id
                  ? 'bg-blue-600 text-white ring-blue-600'
                  : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] ring-[var(--color-border)] hover:text-[var(--color-fg)]'
              }`}
              onClick={() => setFindingFilter(id)}
            >
              {label} · {count}
            </button>
          ))}
          <Link to="/computers" className="ml-auto text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">
            {c.openFleet}
          </Link>
        </div>
        <p className="px-5 pt-3 text-xs text-[var(--color-fg-muted)]">{c.managedHint}</p>
        <div className="divide-y divide-[var(--color-border)]">
          {filteredProblems.map((group) => {
            const expanded = expandedRule === group.rule
            return (
              <article key={group.rule} className="px-5 py-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded-xl px-1 text-left transition hover:bg-[var(--color-surface-muted)]/70"
                    onClick={() => setExpandedRule(expanded ? null : group.rule)}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${severityDot[group.severity]}`} />
                      <h3 className="font-semibold text-[var(--color-fg)]">{group.title}</h3>
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${severityTone[group.severity]}`}
                      >
                        {group.affected_computers} {c.pcs}
                      </span>
                    </div>
                    <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-fg-muted)]">{group.description}</p>
                    <div className="mt-2 text-xs text-blue-700 dark:text-blue-300">
                      {expanded ? c.hidePcs : c.showPcs}
                    </div>
                  </button>
                  <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
                    <div className="rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800 dark:bg-blue-500/10 dark:text-blue-200">
                      <strong>{c.recommendation}:</strong> {group.recommendation}
                    </div>
                    {canManage ? (
                      <div className="flex flex-wrap gap-2">
                        {groupStatus(group) === 'open' ? (
                          <>
                            <button
                              type="button"
                              className="rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-800 disabled:opacity-50 dark:border-blue-500/30 dark:bg-black/20 dark:text-blue-200"
                              disabled={actionId === group.finding_id}
                              onClick={() => void applyProblemAction(group, 'acknowledged')}
                            >
                              {actionId === group.finding_id ? c.actionBusy : c.acknowledge}
                            </button>
                            <button
                              type="button"
                              className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-semibold text-[var(--color-fg-muted)] disabled:opacity-50"
                              disabled={actionId === group.finding_id}
                              onClick={() => void applyProblemAction(group, 'ignored')}
                            >
                              {c.ignore}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-800 disabled:opacity-50 dark:border-blue-500/30 dark:bg-black/20 dark:text-blue-200"
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
            <div className="p-10 text-center text-sm text-[var(--color-fg-muted)]">{c.noItems}</div>
          ) : null}
        </div>
      </section>

      {detailComputerId != null ? (
        <ComputerDetailModal computerId={detailComputerId} onClose={() => setDetailComputerId(null)} />
      ) : null}
    </div>
  )
}
