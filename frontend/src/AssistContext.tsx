import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AssistViewer } from './components/AssistViewer'
import { api, type AssistSession } from './api'
import { useToast } from './ToastContext'
import { useT } from './i18n/LocaleContext'

type AssistApi = {
  start: (hostname: string) => Promise<void>
}

const AssistContext = createContext<AssistApi | null>(null)

export function AssistProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const toast = useToast()
  const [session, setSession] = useState<AssistSession | null>(null)

  const start = useCallback(
    async (hostname: string) => {
      try {
        const next = await api.assistStart(hostname)
        setSession(next)
      } catch (ex) {
        toast.error(ex instanceof Error ? ex.message : t('remoteConnect.assistFail'))
      }
    },
    [t, toast],
  )

  const value = useMemo(() => ({ start }), [start])

  return (
    <AssistContext.Provider value={value}>
      {children}
      {session ? <AssistViewer session={session} onClose={() => setSession(null)} /> : null}
    </AssistContext.Provider>
  )
}

export function useAssist() {
  const ctx = useContext(AssistContext)
  if (!ctx) throw new Error('useAssist must be used within AssistProvider')
  return ctx
}
