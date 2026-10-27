import { useEffect, useState } from 'react'
import { pingHealth } from '../api/client'

/** Polls /api/v1/health. False only after a failed ping (or browser offline). */
export function useApiHealth(intervalMs = 12_000): boolean {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine)

  useEffect(() => {
    let cancelled = false

    const ping = async () => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        if (!cancelled) setOnline(false)
        return
      }
      const ok = await pingHealth()
      if (!cancelled) setOnline(ok)
    }

    void ping()
    const id = window.setInterval(() => void ping(), intervalMs)
    const onOnline = () => void ping()
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [intervalMs])

  return online
}
