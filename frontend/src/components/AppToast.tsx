import { IconClose } from './icons'

export type ToastTone = 'info' | 'warn' | 'ok' | 'busy'

type Props = {
  message: string
  tone?: ToastTone
  onDismiss: () => void
  closeLabel: string
}

/** Blue side toast — same look as Printers page notifications. */
export function AppToast({ message, tone = 'info', onDismiss, closeLabel }: Props) {
  const accent =
    tone === 'warn'
      ? 'bg-sky-100'
      : tone === 'busy'
        ? 'bg-sky-200 animate-pulse'
        : tone === 'ok'
          ? 'bg-emerald-200'
          : 'bg-white/80'
  return (
    <div
      role="status"
      className="toast-enter-right fixed bottom-6 right-6 z-[100] flex max-w-[min(28rem,calc(100vw-3rem))] items-start gap-3 rounded-xl border border-white/15 bg-[var(--color-primary)] px-4 py-3 text-sm font-medium leading-snug text-white shadow-[0_18px_40px_-14px_rgb(37_99_235/0.55)] dark:border-white/20 dark:shadow-[0_18px_44px_-12px_rgb(0_0_0/0.55)]"
    >
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${accent}`} aria-hidden />
      <span className="min-w-0 flex-1 whitespace-pre-line text-white">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg p-1.5 text-white transition hover:bg-white/25"
        aria-label={closeLabel}
      >
        <IconClose className="h-7 w-7" />
      </button>
    </div>
  )
}
