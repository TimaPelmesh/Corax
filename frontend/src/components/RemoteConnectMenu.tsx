import { useEffect, useRef, useState } from 'react'
import { useT } from '../i18n/LocaleContext'
import { downloadRdpFile, REMOTE_CONNECT_METHODS, rdpTargetFor } from '../lib/remoteConnect'
import { useToast } from '../ToastContext'

export function RemoteConnectMenu({
  hostname,
  ip,
  compact = false,
}: {
  hostname?: string | null
  ip?: string | null
  compact?: boolean
}) {
  const t = useT()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const target = rdpTargetFor(hostname, ip)

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!target) return null
  const host = target

  function launchRdp() {
    const result = downloadRdpFile(host)
    setOpen(false)
    if (!result.ok) {
      toast.error(t('remoteConnect.invalidTarget'))
      return
    }
    toast.ok(t('remoteConnect.rdpStarted', { host: result.target }))
  }

  if (compact) {
    return (
      <button
        type="button"
        className="app-btn app-btn-secondary !min-h-0 !px-1.5 !py-1"
        title={t('remoteConnect.rdpHint', { host: target })}
        aria-label={t('remoteConnect.title')}
        onClick={launchRdp}
      >
        {t('remoteConnect.short')}
      </button>
    )
  }

  return (
    <div ref={boxRef} className="relative">
      <button
        type="button"
        className="app-btn app-btn-secondary shrink-0 text-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('remoteConnect.title')}
        onClick={() => setOpen((v) => !v)}
      >
        {compact ? t('remoteConnect.short') : t('remoteConnect.title')}
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
        >
          {REMOTE_CONNECT_METHODS.map((method) => {
            if (method.id === 'rdp') {
              return (
                <button
                  key={method.id}
                  type="button"
                  role="menuitem"
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-[var(--color-bg-muted)]"
                  onClick={launchRdp}
                >
                  <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t('remoteConnect.rdp')}</span>
                  <span className="text-[11px] text-[var(--color-fg-muted)]">
                    {t('remoteConnect.rdpHint', { host: target })}
                  </span>
                </button>
              )
            }
            const titleKey = method.id === 'assist' ? 'remoteConnect.assist' : 'remoteConnect.dameware'
            const soonKey = method.id === 'assist' ? 'remoteConnect.assistSoon' : 'remoteConnect.damewareSoon'
            return (
              <div
                key={method.id}
                role="menuitem"
                aria-disabled="true"
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left opacity-55"
              >
                <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t(titleKey)}</span>
                <span className="text-[11px] text-[var(--color-fg-muted)]">{t(soonKey)}</span>
              </div>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
