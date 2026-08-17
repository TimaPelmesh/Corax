import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api, type TicketHandlerIntakeResult, type TicketHandlerPublicContext } from '../api'
import { matchTitleHints } from '../lib/titleKeywordHints'

function hashParams() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''))
}

function friendlyError(raw: string): string {
  const s = (raw || '').toLowerCase()
  if (s.includes('выключен') || s.includes('disabled') || s.includes('404')) {
    return 'Сервис помощи сейчас выключен. Напишите в IT или попробуйте чуть позже.'
  }
  if (s.includes('локальной сети') || s.includes('секрет') || s.includes('403')) {
    return 'Форму нужно открыть с рабочего ПК в офисной сети (через ярлык CORAX).'
  }
  if (s.includes('failed to fetch') || s.includes('network')) {
    return 'Не удалось связаться с сервером CORAX. Проверьте сеть и попробуйте снова.'
  }
  return raw || 'Что-то пошло не так. Попробуйте ещё раз.'
}

export function TicketHandlerClientPage() {
  const params = useMemo(() => hashParams(), [])
  const hostname = params.get('pc')?.trim() ?? ''
  const secret = params.get('secret')?.trim() || params.get('k')?.trim() || undefined

  const [context, setContext] = useState<TicketHandlerPublicContext | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TicketHandlerIntakeResult | null>(null)
  const [sending, setSending] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleHints = useMemo(() => matchTitleHints(titleDraft), [titleDraft])

  useEffect(() => {
    if (!hostname) return
    api
      .ticketHandlerPublicContext(hostname, secret)
      .then(setContext)
      .catch((e) => setError(friendlyError(e instanceof Error ? e.message : String(e))))
  }, [hostname, secret])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!context || sending || result) return
    const form = new FormData(event.currentTarget)
    setSending(true)
    setError('')
    try {
      const out = await api.ticketHandlerIntake({
        hostname: context.hostname,
        title: String(form.get('title') ?? ''),
        description: String(form.get('description') ?? ''),
        secret,
      })
      setResult(out)
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  const field =
    'mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-[15px] leading-relaxed outline-none transition placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_18%,transparent)]'

  const ticketLabel =
    result?.ticket_no != null
      ? `№${result.ticket_no}`
      : result?.request_id != null
        ? `№${result.request_id}`
        : null

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] p-4 text-[var(--color-fg)] sm:p-6">
      <section className="app-card w-full max-w-lg overflow-hidden">
        <div className="border-b border-[var(--color-border)] px-6 py-7 sm:px-8">
          <p className="brand-wordmark !text-[1.15rem]">Corax</p>
          <h1 className="mt-3 text-[1.75rem] font-semibold tracking-tight">Новая заявка</h1>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-[var(--color-fg-muted)]">
            Коротко опишите проблему — заявка сразу попадёт к специалистам.
          </p>
        </div>

        <div className="px-6 py-6 sm:px-8 sm:py-7">
          {!hostname ? (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3.5 text-[15px] leading-relaxed text-amber-950 dark:text-amber-100">
              Откройте эту страницу через ярлык CORAX на своём рабочем компьютере — так мы поймём, с какого ПК
              пришла просьба о помощи.
            </div>
          ) : null}

          {error ? (
            <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3.5 text-[15px] leading-relaxed text-red-800 dark:text-red-200">
              {error}
            </div>
          ) : null}

          {!context && hostname && !error ? (
            <p className="py-8 text-center text-[15px] text-[var(--color-fg-muted)]">Подключаемся к вашему ПК…</p>
          ) : null}

          {result ? (
            <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-4 text-emerald-950 dark:text-emerald-100">
                <p className="text-lg font-semibold">
                  {ticketLabel ? `Заявка принята, ${ticketLabel}` : 'Заявка принята'}
                </p>
                <p className="mt-1.5 text-[15px] leading-relaxed opacity-90">
                  Специалист уже видит её в CORAX и свяжется с вами при необходимости.
                </p>
              </div>
              {result.requester_name ? (
                <p className="text-sm text-[var(--color-fg-subtle)]">Обращение от: {result.requester_name}</p>
              ) : null}
              <button
                type="button"
                className="w-full rounded-xl border border-[var(--color-border)] px-4 py-3 text-[15px] font-medium hover:bg-[var(--color-bg-muted)]"
                onClick={() => {
                  setResult(null)
                  setTitleDraft('')
                  setError('')
                }}
              >
                Создать ещё одну
              </button>
            </div>
          ) : null}

          {context && !result ? (
            <form className="grid gap-5" onSubmit={submit}>
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/45 px-4 py-3 text-[14px] leading-relaxed">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[var(--color-fg-muted)]">Ваш компьютер</span>
                  <span className="font-semibold tracking-tight">{context.hostname}</span>
                </div>
                {context.requester_hint ? (
                  <div className="mt-1 text-[var(--color-fg-muted)]">
                    Сотрудник: <span className="text-[var(--color-fg)]">{context.requester_hint}</span>
                  </div>
                ) : null}
                {context.computer_id == null ? (
                  <p className="mt-2 text-[13px] text-amber-800 dark:text-amber-200">
                    ПК пока не в инвентаре — ничего страшного, обращение всё равно примем.
                  </p>
                ) : null}
              </div>

              <label className="text-[15px] font-medium">
                О чём речь?
                <input
                  required
                  minLength={3}
                  name="title"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder="Например: bitrix не открывается"
                  className={field}
                  autoComplete="off"
                />
              </label>
              {titleHints.length > 0 ? (
                <div className="-mt-3 flex flex-wrap gap-2">
                  {titleHints.map((hint) => (
                    <button
                      key={hint}
                      type="button"
                      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)]/60 px-2.5 py-1.5 text-left text-[13px] text-[var(--color-fg)] hover:border-[var(--color-primary)] hover:bg-[color-mix(in_srgb,var(--color-primary)_10%,transparent)]"
                      onClick={() => setTitleDraft(hint)}
                    >
                      {hint}
                    </button>
                  ))}
                </div>
              ) : null}
              <label className="text-[15px] font-medium">
                Подробности{' '}
                <span className="font-normal text-[var(--color-fg-subtle)]">(по желанию)</span>
                <textarea
                  name="description"
                  placeholder="Что происходит, когда началось и что уже пробовали"
                  className={`${field} min-h-[8.5rem] resize-y`}
                />
              </label>
              <button
                disabled={sending}
                className="rounded-xl bg-[var(--color-primary)] px-4 py-3.5 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sending ? 'Отправляем…' : 'Отправить заявку'}
              </button>
              <p className="text-center text-[13px] leading-relaxed text-[var(--color-fg-subtle)]">
                После отправки вы сразу получите номер заявки.
              </p>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  )
}
