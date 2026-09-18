import { createPortal } from 'react-dom'
import { useT } from '../../i18n/LocaleContext'

type Props = {
  open: boolean
  title: string
  body: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}

export function NetworkMapConfirmDialog({ open, title, body, confirmLabel, onClose, onConfirm }: Props) {
  const t = useT()
  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-[color-mix(in_srgb,var(--color-bg)_50%,black)] p-4"
      role="dialog"
      aria-modal
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-[var(--color-fg-muted)]">{body}</p>
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
            onClick={onConfirm}
            className="rounded-lg bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-white"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
