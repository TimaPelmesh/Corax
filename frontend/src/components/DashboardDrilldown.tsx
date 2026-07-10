import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type DashboardSegmentKind } from '../api'
import { ComputerDetailModal } from './ComputerDetailModal'
import { IconClose } from './icons'

export type DashboardDrilldownSelection = {
  kind: DashboardSegmentKind
  name: string
  chartTitle: string
  displayName?: string
}

type Props = {
  selection: DashboardDrilldownSelection | null
  onClose: () => void
}

export function DashboardDrilldownPanel({ selection, onClose }: Props) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [data, setData] = useState<Awaited<ReturnType<typeof api.dashboardSegmentComputers>> | null>(null)
  const [computerId, setComputerId] = useState<number | null>(null)

  useEffect(() => {
    if (!selection) {
      setData(null)
      setError(null)
      setComputerId(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void api
      .dashboardSegmentComputers(selection.kind, selection.name, selection.chartTitle)
      .then((res) => {
        if (!cancelled) setData(res)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Не удалось загрузить список ПК')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selection])

  useEffect(() => {
    if (!selection) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [selection])

  useEffect(() => {
    if (!selection) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (computerId != null) setComputerId(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selection, onClose, computerId])

  if (!selection) return null

  const shown = data?.items.length ?? 0
  const total = data?.total ?? 0

  return (
    <>
      {createPortal(
        <div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-neutral-950/45 p-3 backdrop-blur-sm sm:items-center sm:p-6"
          role="dialog"
          aria-modal
          aria-labelledby="dashboard-drilldown-title"
          onClick={() => {
            if (computerId != null) return
            onClose()
          }}
        >
          <div
            className="dashboard-enter flex max-h-[min(92dvh,36rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-5 py-4">
              <div className="min-w-0 pr-2">
                <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-neutral-400">{selection.chartTitle}</div>
                <h3 id="dashboard-drilldown-title" className="mt-1 text-lg font-semibold tracking-tight text-neutral-950">
                  {selection.displayName ?? selection.name}
                </h3>
                <p className="mt-1 text-sm text-neutral-500">
                  {loading ? 'Загрузка…' : total ? `${total} ПК` : 'Нет подходящих ПК'}
                  {!loading && total > shown ? ` · показано ${shown}` : null}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-xs font-semibold text-neutral-700 shadow-sm transition hover:border-neutral-300 hover:bg-neutral-50"
                aria-label="Закрыть"
              >
                <IconClose className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2 sm:px-4" aria-live="polite">
              {error ? (
                <p className="mx-1 my-3 rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-800">
                  {error}
                </p>
              ) : loading ? (
                <ul className="divide-y divide-neutral-100">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <li key={i} className="px-3 py-3">
                      <div className="dashboard-skeleton-shimmer h-4 w-2/3 rounded-md" />
                    </li>
                  ))}
                </ul>
              ) : !data?.items.length ? (
                <p className="mx-1 my-6 rounded-xl border border-dashed border-neutral-200 px-4 py-8 text-center text-sm text-neutral-500">
                  Нет ПК для выбранного сегмента.
                </p>
              ) : (
                <ul className="divide-y divide-neutral-100">
                  {data.items.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setComputerId(row.id)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-neutral-900 transition hover:bg-neutral-50"
                      >
                        <span className="min-w-0 truncate">{row.hostname}</span>
                        <span className="shrink-0 text-xs font-semibold text-neutral-400">→</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
      {computerId != null ? (
        <ComputerDetailModal
          computerId={computerId}
          onClose={() => setComputerId(null)}
          overlayZClass="z-[80]"
        />
      ) : null}
    </>
  )
}
