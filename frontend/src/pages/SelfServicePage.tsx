import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from '../api'
import type { SelfServiceContext } from '../api'

function friendlyError(raw: string): string {
  const s = (raw || '').toLowerCase()
  if (s.includes('disabled') || s.includes('404') || s.includes('self-service')) {
    return 'Форма заявок сейчас недоступна. Обратитесь в IT или попробуйте позже.'
  }
  if (s.includes('локальной') || s.includes('403')) {
    return 'Откройте форму через ярлык на рабочем ПК в офисной сети.'
  }
  if (s.includes('не найден') || s.includes('404')) {
    return 'Этот ПК ещё не появился в инвентаре CORAX. Запустите агент или напишите в IT.'
  }
  if (s.includes('failed to fetch') || s.includes('network')) {
    return 'Не удалось связаться с сервером. Проверьте сеть и попробуйте снова.'
  }
  return raw || 'Не получилось отправить. Попробуйте ещё раз.'
}

export function SelfServicePage() {
  const hostname = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pc')?.trim() ?? ''
  const [context, setContext] = useState<SelfServiceContext | null>(null)
  const [error, setError] = useState('')
  const [done, setDone] = useState<number | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!hostname) return
    api
      .selfServiceContext(hostname)
      .then(setContext)
      .catch((e) => setError(friendlyError(e instanceof Error ? e.message : String(e))))
  }, [hostname])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!context || sending || done) return
    const form = new FormData(event.currentTarget)
    setSending(true)
    setError('')
    try {
      const result = await api.createSelfServiceRequest({
        hostname: context.hostname,
        title: String(form.get('title') ?? ''),
        description: String(form.get('description') ?? ''),
      })
      setDone(result.ticket_no ?? result.request_id)
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  const field =
    'mt-1.5 w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-3 text-[15px] leading-relaxed outline-none transition placeholder:text-[var(--color-fg-subtle)] focus:border-[var(--color-primary)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-primary)_18%,transparent)]'

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-bg)] p-4 text-[var(--color-fg)] sm:p-6">
      <section className="app-card w-full max-w-lg overflow-hidden">
        <div className="border-b border-[var(--color-border)] px-6 py-7 sm:px-8">
          <p className="brand-wordmark !text-[1.15rem]">Corax</p>
          <h1 className="mt-3 text-[1.75rem] font-semibold tracking-tight">Нужна помощь?</h1>
          <p className="mt-2 max-w-md text-[15px] leading-relaxed text-[var(--color-fg-muted)]">
            Опишите задачу своими словами — заявка сразу появится у специалистов поддержки.
          </p>
        </div>
        <div className="px-6 py-6 sm:px-8 sm:py-7">
          {!hostname ? (
            <div className="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-3.5 text-[15px] leading-relaxed text-amber-950 dark:text-amber-100">
              Откройте форму через ярлык CORAX на рабочем компьютере — так заявка привяжется к вашему ПК.
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3.5 text-[15px] leading-relaxed text-red-800 dark:text-red-200">
              {error}
            </div>
          ) : null}
          {!context && hostname && !error ? (
            <p className="py-8 text-center text-[15px] text-[var(--color-fg-muted)]">Проверяем ваш компьютер…</p>
          ) : null}
          {done !== null ? (
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-5 text-emerald-950 dark:text-emerald-100">
              <p className="text-lg font-semibold">Заявка №{done} принята</p>
              <p className="mt-1.5 text-[15px] leading-relaxed opacity-90">
                Спасибо! Специалист уже видит её в CORAX и скоро займётся.
              </p>
            </div>
          ) : null}
          {context && done === null ? (
            <form className="grid gap-5" onSubmit={submit}>
              <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/45 px-4 py-3 text-[14px]">
                <span className="text-[var(--color-fg-muted)]">Компьютер: </span>
                <span className="font-semibold">{context.hostname}</span>
              </div>
              <label className="text-[15px] font-medium">
                О чём заявка?
                <input
                  required
                  minLength={3}
                  name="title"
                  placeholder="Например: нужна установка программы"
                  className={field}
                />
              </label>
              <label className="text-[15px] font-medium">
                Подробности <span className="font-normal text-[var(--color-fg-subtle)]">(по желанию)</span>
                <textarea
                  name="description"
                  placeholder="Что требуется и когда удобно сделать"
                  className={`${field} min-h-[8.5rem] resize-y`}
                />
              </label>
              <button
                disabled={sending}
                className="rounded-xl bg-[var(--color-primary)] px-4 py-3.5 text-[15px] font-semibold text-white shadow-sm transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sending ? 'Отправляем…' : 'Отправить заявку'}
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  )
}
