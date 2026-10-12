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
      const tab = window.open('', '_blank')
      try {
        const next = await api.assistStart(hostname)
        const url = `/assist/${encodeURIComponent(next.id)}?host=${encodeURIComponent(next.hostname)}`
        if (!tab) {
          await api.assistEnd(next.id).catch(() => undefined)
          toast.error(t('remoteConnect.assistPopupBlocked'))
          return
        }
        tab.location.replace(url)
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
