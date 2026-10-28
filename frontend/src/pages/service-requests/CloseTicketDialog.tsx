import { AppModal } from '../../components/ui/AppModal'

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
  void dialogAria
  return (
    <AppModal open title={heading} onClose={() => { if (!saving) onCancel() }} size="sm">
      <p className="text-sm leading-relaxed text-[var(--color-fg-muted)]">{hint}</p>
      <p className="mt-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-3.5 py-3 text-sm font-medium text-[var(--color-fg)]">
        {title}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" disabled={saving} className="app-btn app-btn-secondary !min-h-9" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" disabled={saving} className="app-btn app-btn-primary !min-h-9" onClick={onConfirm}>
          {saving ? confirmingLabel : confirmLabel}
        </button>
      </div>
    </AppModal>
  )
}
