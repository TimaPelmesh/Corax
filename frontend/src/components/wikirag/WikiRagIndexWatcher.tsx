import { useEffect, useRef } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { useToast } from '../../ToastContext'
import {
  clearWikiRagIndexJobFinishedFlag,
  getWikiRagIndexJob,
  subscribeWikiRagIndexJob,
  syncWikiRagIndexJobFromStatus,
} from '../../lib/wikiragIndexJob'

/**
 * Keeps WikiRAG indexing alive across route changes: polls index-status
 * (counts only) and toasts when a job finishes.
 */
export function WikiRagIndexWatcher() {
  const t = useT()
  const toast = useToast()
  const toastRef = useRef(toast)
  const tRef = useRef(t)
  toastRef.current = toast
  tRef.current = t

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    const schedule = (ms: number) => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void run(), ms)
    }

    async function run() {
      if (cancelled) return
      try {
        const st = await api.wikiRagIndexStatus()
        if (cancelled) return
        const snap = syncWikiRagIndexJobFromStatus(st)
        if (snap.justFinished) {
          toastRef.current.ok(tRef.current('wikirag.documents.reindexDone'))
          clearWikiRagIndexJobFinishedFlag()
        }
      } catch {
        /* offline / unauthorized — retry later */
      }
      if (cancelled) return
      const job = getWikiRagIndexJob()
      schedule(job.active ? 1800 : 45_000)
    }

    void run()
    const unsub = subscribeWikiRagIndexJob(() => {
      if (getWikiRagIndexJob().active) schedule(350)
    })

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      unsub()
    }
  }, [])

  return null
}
