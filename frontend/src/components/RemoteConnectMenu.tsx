import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n/LocaleContext'
import { rdpLaunchUri, sanitizeRdpTarget } from '../lib/remoteConnect'
import { useToast } from '../ToastContext'

type MenuPos = { top: number; left: number; width: number }

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
  const [pos, setPos] = useState<MenuPos | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const byName = sanitizeRdpTarget(hostname || '')
  const byIp = sanitizeRdpTarget(ip || '')
  const hasTarget = Boolean(byName || byIp)

  function placeMenu() {
    const btn = btnRef.current
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    const width = Math.min(20 * 16, Math.max(16 * 16, window.innerWidth - 16))
    const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8)
    const menuH = menuRef.current?.offsetHeight || 220
    const below = rect.bottom + 6
    const openUp = below + menuH > window.innerHeight - 8
    const top = openUp ? Math.max(8, rect.top - 6 - menuH) : below
    setPos({ top, left, width })
  }

  useLayoutEffect(() => {
    if (!open) return
    placeMenu()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDoc = (event: MouseEvent) => {
      const node = event.target as Node
      if (btnRef.current?.contains(node) || menuRef.current?.contains(node)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onReposition = () => placeMenu()
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [open])

  if (!hasTarget) return null

  function onRdpClick(host: string) {
    setOpen(false)
    toast.ok(t('remoteConnect.rdpStarted', { host }))
  }

  const menu = open
    ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[320] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-xl"
          style={
            pos
              ? { top: pos.top, left: pos.left, width: pos.width }
              : { top: 0, left: 0, visibility: 'hidden' }
          }
        >
          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {t('remoteConnect.how')}
          </p>
          {byName && rdpLaunchUri(byName) ? (
            <a
              role="menuitem"
              href={rdpLaunchUri(byName)!}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left no-underline hover:bg-[var(--color-bg-muted)]"
              onClick={() => onRdpClick(byName)}
            >
              <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t('remoteConnect.rdp')}</span>
              <span className="text-[11px] text-[var(--color-fg-muted)]">
                {t('remoteConnect.rdpByName', { host: byName })}
              </span>
            </a>
          ) : null}
          {byIp && byIp !== byName && rdpLaunchUri(byIp) ? (
            <a
              role="menuitem"
              href={rdpLaunchUri(byIp)!}
              className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left no-underline hover:bg-[var(--color-bg-muted)]"
              onClick={() => onRdpClick(byIp)}
            >
              <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t('remoteConnect.rdp')}</span>
              <span className="text-[11px] text-[var(--color-fg-muted)]">
                {t('remoteConnect.rdpByIp', { ip: byIp })}
              </span>
            </a>
          ) : null}
          <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {t('remoteConnect.later')}
          </p>
          <div role="menuitem" aria-disabled="true" className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left opacity-55">
            <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t('remoteConnect.assist')}</span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">{t('remoteConnect.assistSoon')}</span>
          </div>
          <div role="menuitem" aria-disabled="true" className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left opacity-55">
            <span className="text-[13px] font-semibold text-[var(--color-fg)]">{t('remoteConnect.dameware')}</span>
            <span className="text-[11px] text-[var(--color-fg-muted)]">{t('remoteConnect.damewareSoon')}</span>
          </div>
        </div>,
        document.body,
      )
    : null

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={
          compact
            ? 'app-btn app-btn-secondary !min-h-0 !px-1.5 !py-1'
            : 'app-btn app-btn-secondary shrink-0 text-sm'
        }
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('remoteConnect.title')}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {compact ? t('remoteConnect.short') : t('remoteConnect.title')}
      </button>
      {menu}
    </>
  )
}
