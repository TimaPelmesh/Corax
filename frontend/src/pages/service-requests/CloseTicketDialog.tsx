import { createPortal } from 'react-dom'

type Props = {
  title: string
  heading: string
  hint: string
  cancelLabel: string
  confirmLabel: string
  confirmingLabel: string
  dialogAria: string
  saving: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function CloseTicketDialog({
  title,
  heading,
  hint,
  cancelLabel,
  confirmLabel,
  confirmingLabel,
  dialogAria,
  saving,
  onCancel,
  onConfirm,
}: Props) {
  return createPortal(
    <div
      className="app-modal-layer fixed inset-0 z-[200] flex items-end justify-center bg-black/45 p-3 backdrop-blur-[2px] sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={dialogAria}
      onClick={() => {
        if (!saving) onCancel()
      }}
    >
      <div
        className="max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">{heading}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-fg-muted)]">{hint}</p>
        <p className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-3.5 py-3 text-sm font-medium text-[var(--color-fg)]">
          {title}
        </p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-[var(--color-bg-muted)] disabled:opacity-50"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={saving}
            className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={onConfirm}
          >
            {saving ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
