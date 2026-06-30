import { Component, type ErrorInfo, type ReactNode } from 'react'

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
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-white p-6 text-center">
          <h1 className="text-lg font-semibold text-neutral-950">Ошибка интерфейса</h1>
          <p className="max-w-lg text-sm text-neutral-600">
            Обновите страницу. Если снова пусто — пересоберите фронт и перезапустите сервер (
            <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs">npm run build</code> в{' '}
            <code className="font-mono text-xs">frontend</code>).
          </p>
          <pre className="max-h-40 max-w-full overflow-auto rounded-lg border border-red-200 bg-red-50 p-3 text-left text-xs text-red-900">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            className="rounded-lg bg-neutral-950 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
            onClick={() => window.location.reload()}
          >
            Обновить страницу
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
