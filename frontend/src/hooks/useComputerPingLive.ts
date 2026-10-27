import { useEffect, useRef } from 'react'
import { api } from '../api'

export type ComputerPingLiveItem = {
  id: number
  ping_status: string | null
  last_ping_at: string | null
  ip_address: string | null
}

type Options = {
  /** Poll /ping-status interval while the page is mounted. Default 4000. */
  pollMs?: number
  /** Request a full sweep this often while the tab is visible. Default 180000. */
  sweepEveryMs?: number
  /** Called whenever the cache snapshot changes. */
  onItems: (items: ComputerPingLiveItem[]) => void
  enabled?: boolean
}

/**
 * Keeps computer ping_status fresh while a page is open:
 * - polls the DB cache often (no ICMP in this call)
 * - kicks a full sweep on mount / tab focus / periodically (backend cooldown applies)
 *
 * Keep sweeps rare: a full fleet pass can run ~45s; stacking them starves the API
 * and surfaces as browser "Нет ответа от сервера (таймаут)".
 */
export function useComputerPingLive({
  onItems,
  pollMs = 4000,
  sweepEveryMs = 180_000,
  enabled = true,
}: Options) {
  const onItemsRef = useRef(onItems)
  onItemsRef.current = onItems

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let pollTimer: number | null = null
    let sweepTimer: number | null = null

    const pull = async (kick: boolean) => {
      try {
        const data = await api.computersPingStatus(kick)
        if (cancelled) return
        onItemsRef.current(data.items)
      } catch {
        /* ignore transient */
      }
    }

    const requestSweep = () => {
      void api.computersPingSweep().catch(() => undefined)
    }

    const schedulePoll = () => {
      pollTimer = window.setTimeout(async () => {
        await pull(false)
        if (!cancelled) schedulePoll()
      }, pollMs)
    }

    const scheduleSweep = () => {
      sweepTimer = window.setTimeout(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
          requestSweep()
        }
        if (!cancelled) scheduleSweep()
      }, sweepEveryMs)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        requestSweep()
        void pull(true)
      }
    }

    void pull(true).then(() => {
      if (cancelled) return
      schedulePoll()
      scheduleSweep()
      // Immediate UI kick so known-but-stale statuses don't wait for drip alone.
      requestSweep()
    })

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)

    return () => {
      cancelled = true
      if (pollTimer != null) window.clearTimeout(pollTimer)
      if (sweepTimer != null) window.clearTimeout(sweepTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [enabled, pollMs, sweepEveryMs])
}
