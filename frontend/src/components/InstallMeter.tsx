import { useEffect, useRef, useState } from 'react'
import { installStepIndex, nextInstallProgress } from '../lib/installProgress'

export type InstallRunStatus = 'idle' | 'run' | 'ok' | 'fail'

type StepState = 'wait' | 'now' | 'passed' | 'done' | 'fail'

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function stepState(index: number, current: number, status: InstallRunStatus): StepState {
  if (status === 'ok') return 'done'
  if (status === 'fail') return index === current ? 'fail' : index < current ? 'passed' : 'wait'
  if (index === current) return 'now'
  if (index < current) return 'passed'
  return 'wait'
}

const MARK: Record<StepState, string> = {
  wait: 'border border-[var(--color-border)] text-[var(--color-fg-subtle)]',
  now: 'bg-[var(--color-primary)] text-white motion-safe:animate-pulse',
  passed: 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  fail: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

export function InstallMeter({
  status,
  steps,
  doneLabel,
  failLabel,
}: {
  status: InstallRunStatus
  steps: readonly string[]
  doneLabel: string
  failLabel: string
}) {
  const [value, setValue] = useState(0)
  const started = useRef(0)

  useEffect(() => {
    if (status === 'idle') {
      setValue(0)
      return
    }
    if (status === 'ok') {
      setValue(100)
      return
    }
    if (status === 'fail') return
    started.current = Date.now()
    if (prefersReducedMotion()) {
      setValue(55)
      return
    }
    setValue(8)
    const id = window.setInterval(() => {
      const elapsed = Date.now() - started.current
      setValue((current) => nextInstallProgress(current, elapsed))
    }, 280)
    return () => window.clearInterval(id)
  }, [status])

  if (status === 'idle' || steps.length === 0) return null

  const shown = status === 'ok' ? 100 : value
  const current = installStepIndex(shown, steps.length)
  const title = status === 'ok' ? doneLabel : status === 'fail' ? failLabel : (steps[current] ?? steps[0])
  const bar =
    status === 'ok'
      ? 'bg-emerald-500'
      : status === 'fail'
        ? 'bg-red-500'
        : 'bg-[var(--color-primary)]'

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-3.5 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium text-[var(--color-fg)]" aria-live="polite">
          {title}
        </p>
        <span className="shrink-0 text-xs font-medium tabular-nums text-[var(--color-fg-subtle)]">
          {Math.round(shown)}%
        </span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-muted)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={title}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none ${bar}`}
          style={{ width: `${Math.max(shown > 0 ? 4 : 0, shown)}%` }}
        />
      </div>
      <ol className="mt-3 space-y-1.5">
        {steps.map((label, index) => {
          const state = stepState(index, current, status)
          return (
            <li key={label} className="flex items-center gap-2 text-xs" aria-current={state === 'now' ? 'step' : undefined}>
              <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${MARK[state]}`}>
                {state === 'done' ? '✓' : state === 'fail' ? '!' : index + 1}
              </span>
              <span className={state === 'now' || state === 'done' ? 'font-medium text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]'}>
                {label}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
