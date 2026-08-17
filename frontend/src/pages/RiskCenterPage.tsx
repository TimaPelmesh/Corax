import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  api,
  type RiskAiInsight,
  type RiskComputer,
  type RiskFinding,
  type RiskHistoryPoint,
  type RiskOverview,
} from '../api'
import { useAuth } from '../AuthContext'
import { ComputerDetailModal } from '../components/ComputerDetailModal'
import { IconActivity, IconCheckBadge, IconLock } from '../components/icons'
import { PageHeader } from '../components/PageHeader'
import { useLocale } from '../i18n/LocaleContext'
import { loadWikiRagLmSettings } from '../lib/wikiragLmSettings'
import { useToast } from '../ToastContext'

const COPY = {
  ru: {
    title: 'Центр рисков',
    subtitle: 'Проверяем парк по понятным правилам, а локальный AI помогает увидеть закономерности',
    loading: 'Анализируем состояние парка…',
    health: 'Здоровье парка',
    healthHint: 'Чем выше, тем меньше подтверждённых рисков',
    critical: 'Критические',
    high: 'Высокий риск',
    medium: 'Требуют внимания',
    healthy: 'Без заметных рисков',
    aiTitle: 'Инсайты локального AI',
    aiHint: 'Модель получает только компактную сводку рассчитанных рисков — не полный инвентарь.',
    aiRun: 'Проанализировать',
    aiRefresh: 'Обновить анализ',
    aiBusy: 'Модель анализирует…',
    aiEmpty: 'Запустите анализ, чтобы получить приоритеты и связи между проблемами.',
    aiPermission: 'Запуск доступен редакторам и администраторам.',
    categories: 'Откуда складывается риск',
    affected: 'ПК затронуто',
    computers: 'Компьютеры с наибольшим риском',
    findings: 'Важные наблюдения',
    search: 'Поиск по компьютеру или проблеме',
    all: 'Все уровни',
    noItems: 'По выбранному фильтру ничего не найдено',
    recommendation: 'Что сделать',
    score: 'риск',
    findingsCount: 'наблюдений',
    openFleet: 'Открыть парк',
    updated: 'Рассчитано',
    total: 'Всего ПК',
    antivirus: 'Антивирус подтверждён',
    antivirusAttention: 'Антивирус требует внимания',
    antivirusUnknown: 'Нет данных об антивирусе',
    computer: 'Компьютер',
    antivirusColumn: 'Антивирус',
    antivirusProtected: 'Подтверждён',
    antivirusNeedsAttention: 'Требует внимания',
    antivirusNoData: 'Нет данных',
    history: 'История здоровья парка',
    historyHint: 'Снимки оценки. Подтверждённые и игнорируемые наблюдения не снижают балл.',
    historyEmpty: 'История появится после нескольких расчётов.',
    historyScore: 'здоровье',
    openFindings: 'Открытые',
    acknowledged: 'Подтверждённые',
    ignored: 'Игнорируемые',
    acknowledge: 'Подтвердить',
    ignore: 'Игнорировать',
    reopen: 'Вернуть',
    actionBusy: 'Сохраняем…',
    actionSaved: 'Статус наблюдения обновлён',
    openComputer: 'Открыть карточку ПК',
    managedHint: 'Подтверждение снимает баллы, пока проблема не будет возвращена в работу.',
  },
  en: {
    title: 'Risk center',
    subtitle: 'Deterministic fleet checks with optional local-AI pattern analysis',
    loading: 'Analyzing fleet health…',
    health: 'Fleet health',
    healthHint: 'Higher means fewer confirmed risks',
    critical: 'Critical',
    high: 'High risk',
    medium: 'Needs attention',
    healthy: 'No notable risks',
    aiTitle: 'Local AI insights',
    aiHint: 'The model receives only a compact calculated summary, not the full inventory.',
    aiRun: 'Analyze',
    aiRefresh: 'Refresh analysis',
    aiBusy: 'Model is analyzing…',
    aiEmpty: 'Run analysis to discover priorities and relationships between issues.',
    aiPermission: 'Editors and administrators can run the analysis.',
    categories: 'Risk composition',
    affected: 'computers affected',
    computers: 'Highest-risk computers',
    findings: 'Important findings',
    search: 'Search computer or finding',
    all: 'All levels',
    noItems: 'Nothing matches the selected filter',
    recommendation: 'Recommended action',
    score: 'risk',
    findingsCount: 'findings',
    openFleet: 'Open fleet',
    updated: 'Calculated',
    total: 'Total computers',
    antivirus: 'Antivirus confirmed',
    antivirusAttention: 'Antivirus needs attention',
    antivirusUnknown: 'No antivirus data',
    computer: 'Computer',
    antivirusColumn: 'Antivirus',
    antivirusProtected: 'Confirmed',
    antivirusNeedsAttention: 'Needs attention',
    antivirusNoData: 'No data',
    history: 'Fleet health history',
    historyHint: 'Score snapshots. Acknowledged and ignored findings do not reduce the score.',
    historyEmpty: 'History will appear after a few calculations.',
    historyScore: 'health',
    openFindings: 'Open',
    acknowledged: 'Acknowledged',
    ignored: 'Ignored',
    acknowledge: 'Acknowledge',
    ignore: 'Ignore',
    reopen: 'Reopen',
    actionBusy: 'Saving…',
    actionSaved: 'Finding status updated',
    openComputer: 'Open computer card',
    managedHint: 'Acknowledgement removes the score until the finding is reopened.',
  },
} as const

type RiskLevel = 'all' | RiskComputer['level']
type FindingFilter = 'open' | 'acknowledged' | 'ignored'

const levelTone: Record<RiskComputer['level'], string> = {
  critical: 'border-blue-600/40 bg-blue-600/15 text-blue-800 dark:text-blue-200',
  high: 'border-blue-500/35 bg-blue-500/10 text-blue-700 dark:text-blue-200',
  medium: 'border-blue-400/30 bg-blue-400/10 text-blue-700 dark:text-blue-300',
  healthy: 'border-blue-300/25 bg-blue-300/10 text-blue-600 dark:text-blue-300',
}

const severityDot: Record<RiskFinding['severity'], string> = {
  critical: 'bg-blue-800 dark:bg-blue-300',
  high: 'bg-blue-600 dark:bg-blue-400',
  medium: 'bg-blue-400 dark:bg-blue-500',
  low: 'bg-blue-300 dark:bg-blue-600',
}

function findingStatus(finding: RiskFinding): FindingFilter {
  return finding.status === 'acknowledged' || finding.status === 'ignored' ? finding.status : 'open'
}

function RiskSkeleton({ text }: { text: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-blue-100 border-t-blue-600" />
      <p className="text-sm text-[var(--color-fg-muted)]">{text}</p>
    </div>
  )
}

function HistoryChart({ items, label }: { items: RiskHistoryPoint[]; label: string }) {
  if (items.length === 0) return null
  return (
    <div className="flex h-16 items-end gap-0.5" aria-label={label}>
      {items.map((point) => (
        <div
          key={point.created_at}
          className="min-w-0 flex-1 rounded-sm bg-blue-600/75 dark:bg-blue-400/70"
          style={{ height: `${Math.max(8, point.fleet_health_score)}%` }}
          title={`${new Date(point.created_at).toLocaleString()} · ${point.fleet_health_score}`}
        />
      ))}
    </div>
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
  const [level, setLevel] = useState<RiskLevel>('all')
  const [query, setQuery] = useState('')
  const [findingFilter, setFindingFilter] = useState<FindingFilter>('open')
  const [aiInsight, setAiInsight] = useState<RiskAiInsight | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [detailComputerId, setDetailComputerId] = useState<number | null>(null)
  const [actionId, setActionId] = useState<string | null>(null)
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

  const filteredComputers = useMemo(() => {
    if (!overview) return []
    const q = query.trim().toLowerCase()
    return overview.computers.filter((computer) => {
      if (level !== 'all' && computer.level !== level) return false
      if (!q) return true
      return (
        computer.hostname.toLowerCase().includes(q) ||
        (computer.ip_address || '').toLowerCase().includes(q) ||
        computer.top_findings.some(
          (finding) =>
            finding.title.toLowerCase().includes(q) ||
            finding.description.toLowerCase().includes(q),
        )
      )
    })
  }, [level, overview, query])

  const filteredFindings = useMemo(() => {
    if (!overview) return []
    return overview.findings.filter((finding) => findingStatus(finding) === findingFilter)
  }, [findingFilter, overview])

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

  async function applyFindingAction(finding: RiskFinding, status: FindingFilter) {
    if (!canManage) return
    setActionId(finding.id)
    try {
      await api.riskFindingAction({ finding_id: finding.id, status })
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
      <PageHeader
        icon={<IconLock className="h-7 w-7" />}
        title={c.title}
        subtitle={c.subtitle}
        actions={
          <div className="text-right text-xs text-[var(--color-fg-muted)]">
            <div>{c.updated}</div>
            <div className="mt-0.5 font-mono">{new Date(overview.generated_at).toLocaleString()}</div>
          </div>
        }
      />

      <div className="flex flex-wrap gap-3 text-sm">
        <span className="rounded-lg bg-blue-600/10 px-3 py-1.5 text-blue-800 dark:text-blue-200">
          {c.health}: <strong>{overview.fleet_health_score}/100</strong>
          {healthDelta != null ? (
            <span className="ml-1 font-medium text-blue-700 dark:text-blue-300">
              {healthDelta > 0 ? `+${healthDelta}` : healthDelta}
            </span>
          ) : null}
        </span>
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {c.total}: <strong>{overview.computers_total}</strong>
        </span>
        <span className="rounded-lg bg-blue-600/10 px-3 py-1.5 text-blue-800 dark:text-blue-200">
          {c.critical}: <strong>{overview.computers_critical}</strong>
        </span>
        <span className="rounded-lg bg-blue-500/10 px-3 py-1.5 text-blue-700 dark:text-blue-200">
          {c.high}: <strong>{overview.computers_high}</strong>
        </span>
        <span className="rounded-lg bg-blue-400/10 px-3 py-1.5 text-blue-700 dark:text-blue-300">
          {c.antivirus}: <strong>{overview.antivirus_protected}/{overview.computers_total} · {antivirusPercent}%</strong>
        </span>
        <span className="rounded-lg bg-blue-300/10 px-3 py-1.5 text-blue-700 dark:text-blue-300">
          {c.antivirusAttention}: <strong>{overview.antivirus_attention}</strong>
        </span>
        <span className="rounded-lg bg-[var(--color-bg-muted)] px-3 py-1.5">
          {c.antivirusUnknown}: <strong>{overview.antivirus_unknown}</strong>
        </span>
      </div>

      <section className="risk-card-enter rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
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

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
        <div className="risk-card-enter rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div className="mb-4 flex items-center gap-2">
            <IconActivity className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            <h2 className="font-semibold text-[var(--color-fg)]">{c.categories}</h2>
          </div>
          <div className="space-y-4">
            {overview.categories.map((category) => (
              <div key={category.id}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-[var(--color-fg)]">{category.label}</span>
                  <span className="text-xs text-[var(--color-fg-muted)]">
                    {category.affected_computers} {c.affected}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[var(--color-surface-muted)]">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-600 to-sky-400 transition-[width] duration-700 ease-out"
                    style={{ width: `${Math.max(4, (category.risk_points / maxCategoryPoints) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="risk-card-enter relative overflow-hidden rounded-xl border border-blue-200/70 bg-gradient-to-br from-blue-50 via-white to-blue-50 p-5 dark:border-blue-500/25 dark:from-blue-500/10 dark:via-[var(--color-surface)] dark:to-blue-500/10">
          <div className="absolute -right-12 -top-12 h-36 w-36 rounded-full bg-blue-400/10 blur-2xl" />
          <div className="relative">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <IconCheckBadge className="h-5 w-5 text-blue-600 dark:text-blue-400" />
                  <h2 className="font-semibold text-[var(--color-fg)]">{c.aiTitle}</h2>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-[var(--color-fg-muted)]">
                  {c.aiHint} {!canRunAi ? c.aiPermission : ''}
                </p>
              </div>
              <button
                type="button"
                className="app-btn app-btn-primary shrink-0"
                disabled={aiBusy || !canRunAi}
                onClick={() => void runAi(Boolean(aiInsight))}
              >
                {aiBusy ? c.aiBusy : aiInsight ? c.aiRefresh : c.aiRun}
              </button>
            </div>
            <div className="mt-4 min-h-32 rounded-xl border border-blue-100 bg-white/80 p-4 text-sm leading-6 text-slate-700 dark:border-blue-500/20 dark:bg-black/10 dark:text-[var(--color-fg)]">
              {aiInsight ? (
                <div className="whitespace-pre-wrap">{aiInsight.text}</div>
              ) : (
                <div className="flex min-h-24 items-center text-[var(--color-fg-muted)]">
                  {c.aiEmpty}
                </div>
              )}
              {aiInsight?.model ? (
                <div className="mt-3 border-t border-[var(--color-border)] pt-2 text-[10px] text-[var(--color-fg-subtle)]">
                  {aiInsight.model}
                  {aiInsight.cached ? ' · cache' : ''}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="risk-card-enter overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="flex flex-col gap-3 border-b border-[var(--color-border)] p-5 lg:flex-row lg:items-center lg:justify-between">
          <h2 className="font-semibold text-[var(--color-fg)]">{c.computers}</h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              className="app-input min-w-[16rem]"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={c.search}
            />
            <select className="app-input sm:w-44" value={level} onChange={(event) => setLevel(event.target.value as RiskLevel)}>
              <option value="all">{c.all}</option>
              <option value="critical">{c.critical}</option>
              <option value="high">{c.high}</option>
              <option value="medium">{c.medium}</option>
              <option value="healthy">{c.healthy}</option>
            </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 text-xs uppercase tracking-wide text-[var(--color-fg-subtle)]">
              <tr>
                <th className="px-4 py-3">{c.computer}</th>
                <th className="px-4 py-3">{c.score}</th>
                <th className="px-4 py-3">{c.antivirusColumn}</th>
                <th className="px-4 py-3">{c.findings}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {filteredComputers.slice(0, 100).map((computer) => (
                <tr
                  key={computer.id}
                  className="cursor-pointer transition-colors hover:bg-[var(--color-bg-muted)]/60"
                  onClick={() => setDetailComputerId(computer.id)}
                  title={c.openComputer}
                >
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[var(--color-fg)]">{computer.hostname}</div>
                    <div className="mt-1 text-xs text-[var(--color-fg-muted)]">
                      {[computer.ip_address, computer.os_name].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${levelTone[computer.level]}`}>
                      {computer.risk_score}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">
                    <span className="inline-flex rounded-full border border-blue-400/30 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300">
                      {computer.antivirus_status === 'protected'
                        ? c.antivirusProtected
                        : computer.antivirus_status === 'attention'
                          ? c.antivirusNeedsAttention
                          : c.antivirusNoData}
                    </span>
                  </td>
                  <td className="min-w-[22rem] px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {computer.top_findings.map((finding) => (
                        <span key={finding.id} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500/8 px-2 py-1 text-xs text-[var(--color-fg-muted)]">
                          <span className={`h-1.5 w-1.5 rounded-full ${severityDot[finding.severity]}`} />
                          {finding.title}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {filteredComputers.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-10 text-center text-sm text-[var(--color-fg-muted)]">
                    {c.noItems}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section className="risk-card-enter rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="font-semibold text-[var(--color-fg)]">{c.findings}</h2>
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{c.managedHint}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {([
              ['open', c.openFindings, overview.findings_open ?? overview.findings_total],
              ['acknowledged', c.acknowledged, overview.findings_acknowledged ?? 0],
              ['ignored', c.ignored, overview.findings_ignored ?? 0],
            ] as const).map(([id, label, count]) => (
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
            <Link to="/computers" className="text-sm font-medium text-blue-600 hover:underline dark:text-blue-400">
              {c.openFleet}
            </Link>
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {filteredFindings.slice(0, 12).map((finding) => (
            <article key={finding.id} className="rounded-xl border border-[var(--color-border)] p-4">
              <div className="flex items-start gap-3">
                <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${severityDot[finding.severity]}`} />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="text-left text-xs font-medium text-blue-700 hover:underline dark:text-blue-300"
                    onClick={() => setDetailComputerId(finding.computer_id)}
                  >
                    {finding.hostname}
                  </button>
                  <h3 className="mt-1 font-semibold text-[var(--color-fg)]">{finding.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-fg-muted)]">{finding.description}</p>
                  <div className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-xs leading-relaxed text-blue-800 dark:bg-blue-500/10 dark:text-blue-200">
                    <strong>{c.recommendation}:</strong> {finding.recommendation}
                  </div>
                  {canManage ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {findingStatus(finding) === 'open' ? (
                        <>
                          <button
                            type="button"
                            className="rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-800 disabled:opacity-50 dark:border-blue-500/30 dark:bg-black/20 dark:text-blue-200"
                            disabled={actionId === finding.id}
                            onClick={() => void applyFindingAction(finding, 'acknowledged')}
                          >
                            {actionId === finding.id ? c.actionBusy : c.acknowledge}
                          </button>
                          <button
                            type="button"
                            className="rounded-lg border border-[var(--color-border)] px-2.5 py-1 text-xs font-semibold text-[var(--color-fg-muted)] disabled:opacity-50"
                            disabled={actionId === finding.id}
                            onClick={() => void applyFindingAction(finding, 'ignored')}
                          >
                            {c.ignore}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="rounded-lg border border-blue-200 bg-white px-2.5 py-1 text-xs font-semibold text-blue-800 disabled:opacity-50 dark:border-blue-500/30 dark:bg-black/20 dark:text-blue-200"
                          disabled={actionId === finding.id}
                          onClick={() => void applyFindingAction(finding, 'open')}
                        >
                          {actionId === finding.id ? c.actionBusy : c.reopen}
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
          {filteredFindings.length === 0 ? (
            <div className="col-span-full p-8 text-center text-sm text-[var(--color-fg-muted)]">{c.noItems}</div>
          ) : null}
        </div>
      </section>

      {detailComputerId != null ? (
        <ComputerDetailModal computerId={detailComputerId} onClose={() => setDetailComputerId(null)} />
      ) : null}
    </div>
  )
}
