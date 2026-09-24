import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translateStatic } from './i18n/LocaleContext'

type Props = { children: ReactNode; inline?: boolean }

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[UI]', error, info.componentStack)
  }

  private retry = () => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          className={`flex flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-6 text-center ${
            this.props.inline ? 'min-h-0 flex-1' : 'min-h-dvh'
          }`}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--color-primary)]">
            Corax
          </p>
          <h1 className="text-lg font-semibold text-[var(--color-fg)]">
            {translateStatic('common.error')}
          </h1>
          <p className="max-w-lg text-sm leading-relaxed text-[var(--color-fg-muted)]">
            {translateStatic('common.crashHint')}
          </p>
          <pre className="max-h-40 max-w-full overflow-auto rounded-xl border border-[var(--color-error-border)] bg-[var(--color-error-bg)] px-3 py-2.5 text-left text-xs text-[var(--color-error-fg)]">
            {this.state.error.message}
          </pre>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
              onClick={this.retry}
            >
              {translateStatic('common.tryAgain')}
            </button>
            <button
              type="button"
              className="rounded-lg bg-[var(--color-primary)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
              onClick={() => window.location.reload()}
            >
              {translateStatic('common.refresh')}
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
