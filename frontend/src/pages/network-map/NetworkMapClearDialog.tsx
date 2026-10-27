import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../../i18n/LocaleContext'

type Props = {
  open: boolean
  onClose: () => void
  onConfirm: () => void
}

export function NetworkMapClearDialog({ open, onClose, onConfirm }: Props) {
  const t = useT()
  const [typed, setTyped] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const phrase = t('networkMap.blankPhrase')
  const ok = typed.trim().toLowerCase() === phrase.toLowerCase()

  useEffect(() => {
    if (!open) return
    setTyped('')
    const timer = window.setTimeout(() => inputRef.current?.focus(), 40)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[color-mix(in_srgb,var(--color-bg)_42%,black)] p-4 backdrop-blur-[6px]"
      role="dialog"
      aria-modal
      aria-labelledby="network-map-clear-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_28px_80px_-32px_rgba(0,0,0,0.7)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative h-28 overflow-hidden bg-[var(--color-bg)]">
          <div className="absolute inset-0 opacity-70 [background-image:radial-gradient(circle,color-mix(in_srgb,var(--color-fg)_18%,transparent)_1.1px,transparent_1.2px)] [background-size:18px_18px]" />
          <div className="absolute inset-0 bg-[radial-gradient(420px_160px_at_50%_120%,color-mix(in_srgb,var(--color-primary)_22%,transparent),transparent_70%)]" />
          <div className="absolute left-1/2 top-1/2 h-10 w-40 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[color-mix(in_srgb,var(--color-surface)_70%,transparent)]" />
        </div>
        <div className="px-5 py-4">
          <h2 id="network-map-clear-title" className="text-base font-semibold">
            {t('networkMap.blankTitle')}
          </h2>
          <p className="mt-1.5 text-sm leading-6 text-[var(--color-fg-muted)]">{t('networkMap.blankBody')}</p>
          <label className="mt-3 block text-xs text-[var(--color-fg-subtle)]">
            {t('networkMap.blankTypeHint')}
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') onClose()
                if (e.key === 'Enter' && ok) onConfirm()
              }}
              placeholder={phrase}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
            />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-bg-muted)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              disabled={!ok}
              onClick={onConfirm}
              className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('networkMap.blankConfirmBtn')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
