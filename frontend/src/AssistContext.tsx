import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { api } from './api'
import { useToast } from './ToastContext'
import { useT } from './i18n/LocaleContext'

type AssistApi = {
  start: (hostname: string) => Promise<void>
}

const AssistContext = createContext<AssistApi | null>(null)

export function AssistProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const toast = useToast()

  const start = useCallback(
    async (hostname: string) => {
      const width = Math.min(1680, Math.max(1100, window.screen.availWidth - 48))
      const height = Math.min(1000, Math.max(700, window.screen.availHeight - 48))
      const left = Math.max(0, (window.screen.availWidth - width) / 2)
      const top = Math.max(0, (window.screen.availHeight - height) / 2)
      const name = `corax-assist-${hostname.replace(/[^\w.-]+/g, '_')}`
      const tab = window.open(
        '',
        name,
        `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no,menubar=no,toolbar=no,location=no,status=no`,
      )
      try {
        const next = await api.assistStart(hostname)
        const url = `/assist/${encodeURIComponent(next.id)}?host=${encodeURIComponent(next.hostname)}`
        if (!tab) {
          await api.assistEnd(next.id).catch(() => undefined)
          toast.error(t('remoteConnect.assistPopupBlocked'))
          return
        }
        tab.location.replace(url)
        tab.focus()
      } catch (ex) {
        tab?.close()
        toast.error(ex instanceof Error ? ex.message : t('remoteConnect.assistFail'))
      }
    },
    [t, toast],
  )

  const value = useMemo(() => ({ start }), [start])

  return <AssistContext.Provider value={value}>{children}</AssistContext.Provider>
}

export function useAssist() {
  const ctx = useContext(AssistContext)
  if (!ctx) throw new Error('useAssist must be used within AssistProvider')
  return ctx
}
