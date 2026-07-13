import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translateStatic } from './i18n/LocaleContext'

type Props = { children: ReactNode }

type State = { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[UI]', error, info.componentStack)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white p-6 text-center dark:bg-[#080a0f]">
          <h1 className="text-lg font-semibold text-neutral-950 dark:text-slate-100">
            {translateStatic('common.error')}
          </h1>
          <p className="max-w-lg text-sm text-neutral-600 dark:text-slate-400">
            {translateStatic('common.refresh')}
          </p>
          <pre className="max-h-40 max-w-full overflow-auto rounded-lg border border-red-200 bg-red-50 p-3 text-left text-xs text-red-900 dark:border-red-500/40 dark:bg-red-950/40 dark:text-red-200">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="rounded-lg bg-neutral-950 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-blue-600 dark:hover:bg-blue-500"
            onClick={() => window.location.reload()}
          >
            {translateStatic('common.refresh')}
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
