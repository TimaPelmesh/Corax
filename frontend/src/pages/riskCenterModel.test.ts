import { describe, expect, it } from 'vitest'
import type { RiskProblemGroup } from '../api'
import {
  countByFindingStatus,
  filterRiskProblems,
  groupStatus,
  healthStroke,
  severityTone,
} from './riskCenterModel'

function group(partial: Partial<RiskProblemGroup> & Pick<RiskProblemGroup, 'rule' | 'title'>): RiskProblemGroup {
  return {
    finding_id: partial.finding_id ?? 'f1',
    rule: partial.rule,
    category: partial.category ?? 'general',
    score: partial.score ?? 1,
    title: partial.title,
    description: partial.description ?? '',
    recommendation: partial.recommendation ?? '',
    severity: partial.severity ?? 'medium',
    status: partial.status ?? 'open',
    affected_computers: partial.affected_computers ?? (partial.computers?.length ?? 0),
    finding_count: partial.finding_count ?? (partial.computers?.length ?? 0),
    computers: partial.computers ?? [],
  }
}

describe('groupStatus', () => {
  it('normalizes unknown to open', () => {
    expect(groupStatus(group({ rule: 'a', title: 'A', status: 'open' }))).toBe('open')
    expect(groupStatus(group({ rule: 'a', title: 'A', status: 'acknowledged' }))).toBe('acknowledged')
    expect(groupStatus(group({ rule: 'a', title: 'A', status: 'ignored' }))).toBe('ignored')
  })
})

describe('filterRiskProblems', () => {
  const rows = [
    group({
      rule: 'av',
      title: 'Antivirus missing',
      severity: 'critical',
      status: 'open',
      computers: [{ finding_id: '1', id: 1, hostname: 'PC-ALPHA', ip_address: '10.0.0.1', os_name: 'Win11', evidence: '' }],
    }),
    group({
      rule: 'disk',
      title: 'Disk almost full',
      severity: 'high',
      status: 'acknowledged',
      computers: [{ finding_id: '2', id: 2, hostname: 'PC-BETA', ip_address: null, os_name: null, evidence: '' }],
    }),
    group({
      rule: 'upd',
      title: 'Updates pending',
      severity: 'low',
      status: 'ignored',
      computers: [],
    }),
  ]

  it('filters by finding status and severity', () => {
    expect(filterRiskProblems(rows, { findingFilter: 'open', severity: 'all', query: '' })).toHaveLength(1)
    expect(filterRiskProblems(rows, { findingFilter: 'open', severity: 'high', query: '' })).toHaveLength(0)
    expect(filterRiskProblems(rows, { findingFilter: 'acknowledged', severity: 'high', query: '' })).toHaveLength(1)
  })

  it('matches query against title and hostname', () => {
    expect(filterRiskProblems(rows, { findingFilter: 'open', severity: 'all', query: 'alpha' })).toHaveLength(1)
    expect(filterRiskProblems(rows, { findingFilter: 'open', severity: 'all', query: 'missing' })).toHaveLength(1)
    expect(filterRiskProblems(rows, { findingFilter: 'open', severity: 'all', query: 'zzz' })).toHaveLength(0)
  })
})

describe('countByFindingStatus', () => {
  it('tallies statuses', () => {
    expect(
      countByFindingStatus([
        group({ rule: '1', title: 'a', status: 'open' }),
        group({ rule: '2', title: 'b', status: 'open' }),
        group({ rule: '3', title: 'c', status: 'ignored' }),
      ]),
    ).toEqual({ open: 2, acknowledged: 0, ignored: 1 })
  })
})

describe('healthStroke / severityTone', () => {
  it('maps score bands to token strokes', () => {
    expect(healthStroke(90)).toContain('success')
    expect(healthStroke(60)).toContain('warning')
    expect(healthStroke(10)).toContain('error')
  })

  it('uses semantic token classes for severity chips', () => {
    expect(severityTone.critical).toContain('--color-error')
    expect(severityTone.high).toContain('--color-warning')
    expect(severityTone.medium).toContain('--color-info')
  })
})
