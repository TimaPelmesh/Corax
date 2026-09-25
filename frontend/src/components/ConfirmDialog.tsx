import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../i18n/LocaleContext'

export type ConfirmTone = 'primary' | 'danger'

export type ConfirmOptions = {
  title: string
  body: string
  confirmLabel: string
  tone?: ConfirmTone
}

type DialogProps = ConfirmOptions & {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  tone = 'primary',
  onClose,
  onConfirm,
}: DialogProps) {
  const t = useT()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const timer = window.setTimeout(() => confirmRef.current?.focus(), 0)
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const root = panelRef.current
      if (!root) return
      const items = Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled])'))
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-[color-mix(in_srgb,var(--color-bg)_50%,black)] p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="text-base font-semibold text-[var(--color-fg)]">
          {title}
        </h2>
        {body ? <p className="mt-2 whitespace-pre-line text-sm leading-6 text-[var(--color-fg-muted)]">{body}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="app-btn app-btn-secondary !min-h-9">
            {t('common.cancel')}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={tone === 'danger' ? 'app-btn app-btn-danger !min-h-9' : 'app-btn app-btn-primary !min-h-9'}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function useConfirmDialog() {
  const resolveRef = useRef<((ok: boolean) => void) | null>(null)
  const [pending, setPending] = useState<ConfirmOptions | null>(null)

  const ask = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current?.(false)
      resolveRef.current = resolve
      setPending(options)
    })
  }, [])

  const finish = useCallback((ok: boolean) => {
    const resolve = resolveRef.current
    resolveRef.current = null
    setPending(null)
    resolve?.(ok)
  }, [])

  const dialog = (
    <ConfirmDialog
      open={pending != null}
      title={pending?.title ?? ''}
      body={pending?.body ?? ''}
      confirmLabel={pending?.confirmLabel ?? ''}
      tone={pending?.tone}
      onClose={() => finish(false)}
      onConfirm={() => finish(true)}
    />
  )

  return { ask, dialog }
}
