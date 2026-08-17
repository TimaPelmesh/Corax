import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AppToast, type ToastTone } from './components/AppToast'
import { useLocale } from './i18n/LocaleContext'

export type ToastPayload = {
  message: string
  tone?: ToastTone
}

type ToastApi = {
  show: (message: string, tone?: ToastTone) => void
  info: (message: string) => void
  ok: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
  busy: (message: string) => void
  dismiss: () => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale()
  const [toast, setToast] = useState<ToastPayload | null>(null)
  const timer = useRef<number | null>(null)

  const dismiss = useCallback(() => {
    setToast(null)
    if (timer.current != null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const msg = (message || '').trim()
      if (!msg) return
      setToast({ message: msg, tone })
      if (timer.current != null) window.clearTimeout(timer.current)
      if (tone === 'busy') return
      const ms = tone === 'warn' ? 7000 : 5000
      timer.current = window.setTimeout(() => {
        setToast(null)
        timer.current = null
      }, ms)
    },
    [],
  )

  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      show,
      info: (m) => show(m, 'info'),
      ok: (m) => show(m, 'ok'),
      warn: (m) => show(m, 'warn'),
      error: (m) => show(m, 'warn'),
      busy: (m) => show(m, 'busy'),
      dismiss,
    }),
    [show, dismiss],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toast ? (
        <AppToast
          message={toast.message}
          tone={toast.tone}
          onDismiss={dismiss}
          closeLabel={t('common.close')}
        />
      ) : null}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider')
  }
  return ctx
}
