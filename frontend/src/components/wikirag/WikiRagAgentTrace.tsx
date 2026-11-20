import { useState } from 'react'
import type { WikiRagAgentStep } from '../../api'

const KIND_LABEL: Record<string, string> = {
  goal: 'Цель',
  plan: 'План',
  tool: 'Тул',
  observe: 'Наблюдение',
  critique: 'Проверка',
  answer: 'Ответ',
}

function kindTone(kind: string): string {
  if (kind === 'goal') return 'text-[var(--color-primary)]'
  if (kind === 'critique') return 'text-[var(--color-fg-muted)]'
  if (kind === 'tool') return 'text-[var(--color-fg)]'
  return 'text-[var(--color-fg-muted)]'
}

export function WikiRagAgentTrace({
  steps,
  streaming,
  defaultOpen,
}: {
  steps: WikiRagAgentStep[]
  streaming?: boolean
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen || streaming))
  if (!steps.length) return null

  const running = steps.some((s) => s.status === 'running')
  const title = streaming || running ? 'Ход агента' : 'Ход агента'

  return (
    <div className="mt-2.5 overflow-hidden rounded-xl border border-[var(--color-border)]/80 bg-[var(--color-surface)]/70">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--color-fg-muted)]">
          {(streaming || running) && <span className="wikirag-progress-live h-1.5 w-1.5 rounded-full bg-[var(--color-primary)]" />}
          {title}
          <span className="rounded-md bg-[var(--color-bg-muted)] px-1.5 py-0.5 text-[10px] tabular-nums">
            {steps.length}
          </span>
        </span>
        <span className="text-[11px] text-[var(--color-fg-subtle)]">{open ? 'Скрыть' : 'Показать'}</span>
      </button>
      {open ? (
        <ol className="m-0 space-y-1.5 border-t border-[var(--color-border)]/70 px-3 py-2.5">
          {steps.map((step) => (
            <li key={step.id} className="flex gap-2 text-[12px] leading-snug">
              <span
                className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                  step.status === 'running'
                    ? 'wikirag-progress-live bg-[var(--color-primary)]'
                    : step.status === 'failed'
                      ? 'bg-red-500'
                      : 'bg-[var(--color-border)]'
                }`}
                aria-hidden
              />
              <span className="min-w-0 flex-1">
                <span className={`font-semibold ${kindTone(step.kind)}`}>
                  {KIND_LABEL[step.kind] || step.kind}
                </span>
                <span className="text-[var(--color-fg)]"> — {step.title}</span>
                {step.detail ? (
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-[var(--color-fg-subtle)]">
                    {step.detail}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
