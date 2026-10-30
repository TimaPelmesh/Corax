import { useEffect, useState } from 'react'
import { api } from '../api'
import { NAV_BADGES_KEY, peekCache, putCache } from '../lib/viewCache'
import type { NavCounts } from '../components/layout/navTypes'

export function useNavCounts(enabled: boolean) {
  const [navCounts, setNavCounts] = useState<NavCounts | null>(() => peekCache<NavCounts>(NAV_BADGES_KEY) ?? null)

  useEffect(() => {
    if (!enabled) {
      setNavCounts(null)
      return
    }
    let cancelled = false
    const load = async () => {
      try {
        const badges = await api.dashboardNavBadges()
        if (cancelled) return
        const next = {
          computers: badges.computers_total,
          software: badges.software_unique_titles,
          requestsActive: badges.service_requests_active,
          printers: badges.snmp_printers_total,
          notes: badges.notes_total ?? 0,
        }
        putCache(NAV_BADGES_KEY, next)
        setNavCounts(next)
      } catch {
        /* badges are optional */
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [enabled])

  return navCounts
}
