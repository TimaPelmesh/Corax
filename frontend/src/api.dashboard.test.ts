import { describe, expect, it } from 'vitest'
import { normalizeDashboardSummary, type DashboardSummary } from './api'

function minimalRaw(over: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    computers_total: 10,
    software_installations_total: 0,
    software_unique_titles: 0,
    tags_in_directory: 0,
    snmp_printers_total: 0,
    service_requests_total: 0,
    service_requests_active: 0,
    service_requests_overdue: 0,
    service_requests_on_time_pct: null,
    service_requests_avg_close_hours: null,
    by_os: [],
    by_manufacturer: [],
    by_system_model: [],
    ram_buckets: [],
    top_cpu: [],
    top_software: [],
    top_monitors: [],
    peripheral_kinds: [],
    top_peripherals: [],
    top_disk_devices: [],
    physical_disks_total: 0,
    physical_disks_by_media: [],
    physical_disks_by_size: [],
    physical_disks_by_variant: [],
    ...over,
  } as DashboardSummary
}

describe('normalizeDashboardSummary', () => {
  it('fills missing arrays and notes_total', () => {
    const raw = {
      computers_total: 5,
      computers_online: 3,
      computers_offline: 1,
      software_installations_total: 0,
      software_unique_titles: 2,
      tags_in_directory: 0,
    } as unknown as DashboardSummary
    const out = normalizeDashboardSummary(raw)
    expect(out.computers_unknown).toBe(1)
    expect(out.by_os).toEqual([])
    expect(out.upcoming_notes).toEqual([])
    expect(out.notes_total).toBe(0)
    expect(out.software_unique_titles).toBe(2)
  })

  it('clamps on-time percent', () => {
    const out = normalizeDashboardSummary(
      minimalRaw({ service_requests_on_time_pct: 150 as unknown as number }),
    )
    expect(out.service_requests_on_time_pct).toBe(100)
  })

  it('keeps notes_total from API', () => {
    expect(normalizeDashboardSummary(minimalRaw({ notes_total: 7 })).notes_total).toBe(7)
  })
})
