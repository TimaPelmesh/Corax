import type { RiskProblemGroup } from '../api'

export type FindingFilter = 'open' | 'acknowledged' | 'ignored'
export type SeverityFilter = 'all' | 'critical' | 'high' | 'medium' | 'low'

export function groupStatus(group: RiskProblemGroup): FindingFilter {
  return group.status === 'acknowledged' || group.status === 'ignored' ? group.status : 'open'
}

/** Chip classes from semantic design tokens (no one-off palettes). */
export const severityTone: Record<RiskProblemGroup['severity'], string> = {
  critical: 'border-[var(--color-error-border)] bg-[var(--color-error-bg)] text-[var(--color-error-fg)]',
  high: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)]',
  medium: 'border-[var(--color-info-border)] bg-[var(--color-info-bg)] text-[var(--color-info-fg)]',
  low: 'border-[var(--color-border)] bg-[var(--color-bg-muted)] text-[var(--color-fg-muted)]',
}

export const severityDot: Record<RiskProblemGroup['severity'], string> = {
  critical: 'bg-[var(--color-error-fg)]',
  high: 'bg-[var(--color-warning-fg)]',
  medium: 'bg-[var(--color-info-fg)]',
  low: 'bg-[var(--color-fg-subtle)]',
}

export function healthStroke(score: number) {
  if (score >= 80) return 'stroke-[var(--color-success-fg)]'
  if (score >= 50) return 'stroke-[var(--color-warning-fg)]'
  return 'stroke-[var(--color-error-fg)]'
}

export function filterRiskProblems(
  groups: RiskProblemGroup[],
  opts: { findingFilter: FindingFilter; severity: SeverityFilter; query: string },
): RiskProblemGroup[] {
  const q = opts.query.trim().toLowerCase()
  return groups.filter((group) => {
    if (groupStatus(group) !== opts.findingFilter) return false
    if (opts.severity !== 'all' && group.severity !== opts.severity) return false
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
}

export function countByFindingStatus(groups: RiskProblemGroup[]) {
  const counts = { open: 0, acknowledged: 0, ignored: 0 }
  for (const group of groups) {
    counts[groupStatus(group)] += 1
  }
  return counts
}
