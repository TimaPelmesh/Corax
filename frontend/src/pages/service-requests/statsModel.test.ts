import { describe, expect, it } from 'vitest'
import type { ServiceRequestRow } from '../../api'
import { computeStatsKpi, filterStatsRows, isRequestOverdue } from './statsModel'

function row(partial: Partial<ServiceRequestRow> & Pick<ServiceRequestRow, 'id' | 'title' | 'status'>): ServiceRequestRow {
  return {
    ticket_no: partial.id,
    glpi_id: null,
    description: null,
    priority: 'normal',
    requester_name: null,
    category: null,
    created_by_id: 1,
    created_by_username: 'admin',
    created_at: '2026-01-10T10:00:00Z',
    updated_at: '2026-01-10T10:00:00Z',
    opened_at: '2026-01-10T10:00:00Z',
    planned_close_at: null,
    closed_at: null,
    computer_id: null,
    computer_hostname: null,
    assignee_ids: [],
    assignee_usernames: [],
    ...partial,
  }
}

describe('isRequestOverdue', () => {
  const now = Date.parse('2026-01-20T12:00:00Z')

  it('flags an open ticket past planned close', () => {
    expect(
      isRequestOverdue(
        row({ id: 1, title: 'a', status: 'open', planned_close_at: '2026-01-19T12:00:00Z' }),
        now,
      ),
    ).toBe(true)
  })

  it('ignores done tickets', () => {
    expect(
      isRequestOverdue(
        row({
          id: 2,
          title: 'b',
          status: 'done',
          planned_close_at: '2026-01-19T12:00:00Z',
          closed_at: '2026-01-21T12:00:00Z',
        }),
        now,
      ),
    ).toBe(false)
  })
})

describe('filterStatsRows', () => {
  it('keeps rows inside the opened period', () => {
    const rows = [
      row({ id: 1, title: 'in', status: 'open', opened_at: '2026-01-12T08:00:00' }),
      row({ id: 2, title: 'out', status: 'open', opened_at: '2026-02-01T08:00:00' }),
    ]
    const filtered = filterStatsRows(rows, {
      from: '2026-01-01',
      to: '2026-01-31',
      basis: 'opened',
      onlyWithPlanned: false,
      onlyOverdue: false,
    })
    expect(filtered.map((item) => item.id)).toEqual([1])
  })
})

describe('computeStatsKpi', () => {
  it('computes SLA hit rate from planned vs closed', () => {
    const kpi = computeStatsKpi(
      [
        row({
          id: 1,
          title: 'ok',
          status: 'done',
          planned_close_at: '2026-01-12T12:00:00Z',
          closed_at: '2026-01-11T12:00:00Z',
        }),
        row({
          id: 2,
          title: 'late',
          status: 'done',
          planned_close_at: '2026-01-12T12:00:00Z',
          closed_at: '2026-01-13T12:00:00Z',
        }),
      ],
      Date.parse('2026-01-20T12:00:00Z'),
    )
    expect(kpi.total).toBe(2)
    expect(kpi.done).toBe(2)
    expect(kpi.slaHitRate).toBe(50)
  })
})
