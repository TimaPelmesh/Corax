import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api, type TicketHandlerIntakeResult, type TicketHandlerPublicContext } from '../api'
import { CoraxLogo } from '../components/CoraxLogo'
import { helpGreeting } from '../lib/helpGreeting'

function hashParams() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''))
}

function friendlyError(raw: string): string {
  const s = (raw || '').toLowerCase()
  if (s.includes('выключен') || s.includes('disabled') || s.includes('404')) {
    return 'Сервис помощи сейчас выключен. Напишите в IT или попробуйте чуть позже.'
  }
  if (s.includes('локальной сети') || s.includes('секрет') || s.includes('403')) {
    return 'Форму нужно открыть с рабочего компьютера в офисной сети.'
  }
  if (s.includes('failed to fetch') || s.includes('network') || s.includes('нет связи')) {
    return 'Не удалось связаться с сервером. Проверьте сеть и попробуйте снова.'
  }
  return raw || 'Что-то пошло не так. Попробуйте ещё раз.'
}

function displayName(hint: string) {
  const trimmed = hint.trim()
  const m = trimmed.match(/^(.*)\s*\(([^)]+)\)\s*$/)
  return (m ? m[1] : trimmed).trim()
}

function shortPcName(name: string) {
  const raw = name.trim().replace(/\$+$/, '')
  if (!raw) return ''
  return raw.split('.')[0]
}

export function TicketHandlerClientPage() {
  const params = useMemo(() => hashParams(), [])
  const hintedHost = params.get('pc')?.trim() ?? ''
  const secret = params.get('secret')?.trim() || params.get('k')?.trim() || undefined

  const [context, setContext] = useState<TicketHandlerPublicContext | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TicketHandlerIntakeResult | null>(null)
  const [sending, setSending] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [detecting, setDetecting] = useState(true)

  useEffect(() => {
    let cancelled = false
    setDetecting(true)
    api
      .ticketHandlerPublicContext(hintedHost || undefined, secret)
      .then((ctx) => {
        if (!cancelled) {
          setContext(ctx)
          setError('')
        }
      })
      .catch((e) => {
        if (!cancelled) setError(friendlyError(e instanceof Error ? e.message : String(e)))
      })
      .finally(() => {
        if (!cancelled) setDetecting(false)
      })
    return () => {
      cancelled = true
    }
  }, [hintedHost, secret])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending) return
    const form = event.currentTarget
    const data = new FormData(form)
    setSending(true)
    setError('')
    try {
      const out = await api.ticketHandlerIntake({
        hostname: context?.hostname || hintedHost || undefined,
        title: String(data.get('title') ?? ''),
        description: String(data.get('description') ?? ''),
        secret,
      })
      setResult(out)
      setTitleDraft('')
      form.reset()
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e)))
    } finally {
      setSending(false)
    }
  }

  const ticketLabel =
    result?.ticket_no != null
      ? `№${result.ticket_no}`
      : result?.request_id != null
        ? `№${result.request_id}`
        : null

  const person = context?.requester_hint ? displayName(context.requester_hint) : ''
  const pcName = shortPcName(context?.hostname || hintedHost)
  const place = (context?.location || '').trim()
  const blocked = Boolean(error && !context)
  const hello = helpGreeting(person)

  return (
    <main className="help-page">
      <div className="help-scene" aria-hidden>
        <span className="help-mesh" />
        <span className="help-glow help-glow-a" />
        <span className="help-glow help-glow-b" />
      </div>
      <section className="help-card">
        <header className="help-card-head">
          <div className="help-brand">
            <CoraxLogo variant="wordmark" alt="Corax" className="help-wordmark" />
          </div>
          <h1 className="help-title">{hello}</h1>
          <p className="help-lead">Опишите проблему своими словами.</p>
          {detecting && !pcName ? (
            <p className="help-device is-wait">Уточняем, с какого компьютера заявка…</p>
          ) : null}
          {pcName ? (
            <p className="help-device">
              Заявка уйдёт с компьютера <strong>{pcName}</strong>
              {place ? <span> · {place}</span> : null}
            </p>
          ) : null}
        </header>

        <div className="help-card-body">
          {blocked ? (
            <div className="help-alert" role="alert">
              {error}
            </div>
          ) : null}

          {result && !blocked ? (
            <div className="help-success help-success-banner" role="status">
              <p className="help-success-title">{ticketLabel ? `Заявка принята, ${ticketLabel}` : 'Заявка принята'}</p>
            </div>
          ) : null}

          {!blocked ? (
            <form className="help-form" onSubmit={submit}>
              {error && context ? (
                <div className="help-alert help-alert-soft" role="alert">
                  {error}
                </div>
              ) : null}

              <label className="help-field">
                <span>Что требуется</span>
                <input
                  required
                  minLength={3}
                  name="title"
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  placeholder="Например: поменять картридж в принтере"
                  autoComplete="off"
                  autoFocus
                />
              </label>

              <label className="help-field help-field-quiet">
                <span>
                  Подробности <em>по желанию</em>
                </span>
                <textarea
                  name="description"
                  placeholder="Когда началось, что уже пробовали, номер кабинета"
                  rows={4}
                />
              </label>

              <button type="submit" className="help-submit" disabled={sending}>
                {sending ? (
                  <>
                    <span className="help-spinner" aria-hidden />
                    Отправляем…
                  </>
                ) : (
                  'Отправить заявку'
                )}
              </button>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  )
}
