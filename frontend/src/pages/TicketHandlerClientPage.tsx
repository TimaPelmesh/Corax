import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { api, type TicketHandlerIntakeResult, type TicketHandlerPublicContext, type TicketHandlerPublicTicket } from '../api'
import { CoraxLogo } from '../components/CoraxLogo'
import { titleForPath } from '../documentTitle'
import { useLocale, type MessageKey } from '../i18n/LocaleContext'
import { dayPartGreetingKey, helpGreeting } from '../lib/helpGreeting'
import {
  helpFormDocumentTitle,
  helpTicketAssigneesLine,
  helpTicketNo,
  helpTicketPhase,
  helpTicketPhaseChanges,
  helpTicketPhaseSnaps,
  helpTicketWhen,
  type HelpTicketPhase,
  type HelpTicketPhaseSnap,
} from '../lib/helpTickets'

function hashParams() {
  return new URLSearchParams(window.location.hash.replace(/^#/, ''))
}

function friendlyError(raw: string, t: (key: MessageKey) => string): string {
  const s = (raw || '').toLowerCase()
  if (s.includes('выключен') || s.includes('disabled') || s.includes('404')) {
    return t('ticketHandler.helpForm.errDisabled')
  }
  if (s.includes('локальной сети') || s.includes('секрет') || s.includes('403')) {
    return t('ticketHandler.helpForm.errLan')
  }
  if (s.includes('failed to fetch') || s.includes('network') || s.includes('нет связи')) {
    return t('ticketHandler.helpForm.errNetwork')
  }
  return raw || t('ticketHandler.helpForm.errGeneric')
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

function phaseLabel(phase: HelpTicketPhase, t: (key: MessageKey) => string): string {
  if (phase === 'taken') return t('ticketHandler.helpForm.statusTaken')
  if (phase === 'done') return t('ticketHandler.helpForm.statusDone')
  if (phase === 'cancelled') return t('ticketHandler.helpForm.statusCancelled')
  return t('ticketHandler.helpForm.statusWaiting')
}

function noticeHint(
  to: HelpTicketPhase,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (to === 'done') return t('ticketHandler.helpForm.formNoticeDoneHint')
  if (to === 'cancelled') return t('ticketHandler.helpForm.formNoticeCancelledHint')
  return t('ticketHandler.helpForm.formNoticeTakenHint')
}

type FormNotice = {
  id: number
  ticketNo: string
  to: HelpTicketPhase
}

function noticeForChange(
  to: HelpTicketPhase,
  ticketNo: string,
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
): string {
  if (to === 'done') return t('ticketHandler.helpForm.tabNoticeDone', { ticket: ticketNo })
  if (to === 'cancelled') return t('ticketHandler.helpForm.tabNoticeCancelled', { ticket: ticketNo })
  return t('ticketHandler.helpForm.tabNoticeTaken', { ticket: ticketNo })
}

export function TicketHandlerClientPage() {
  const { t, locale, setLocale } = useLocale()
  const params = useMemo(() => hashParams(), [])
  const hintedHost = params.get('pc')?.trim() ?? ''
  const secret = params.get('secret')?.trim() || params.get('k')?.trim() || undefined

  const [context, setContext] = useState<TicketHandlerPublicContext | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<TicketHandlerIntakeResult | null>(null)
  const [sending, setSending] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [detecting, setDetecting] = useState(true)
  const [tickets, setTickets] = useState<TicketHandlerPublicTicket[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [tabNotice, setTabNotice] = useState<string | null>(null)
  const [unread, setUnread] = useState(0)
  const [alertIds, setAlertIds] = useState<number[]>([])
  const [formNotices, setFormNotices] = useState<FormNotice[]>([])
  const prevSnaps = useRef<HelpTicketPhaseSnap[] | null>(null)
  const blinkOn = useRef(true)

  const hostname = context?.hostname || hintedHost || undefined
  const baseTitle = titleForPath('/h', locale)

  const loadTickets = useCallback(async () => {
    if (!hostname && !secret) return
    try {
      const out = await api.ticketHandlerPublicTickets(hostname, secret)
      const items = out.items || []
      setTickets(items)
      const next = helpTicketPhaseSnaps(items)
      const changes = helpTicketPhaseChanges(prevSnaps.current, next)
      prevSnaps.current = next
      if (changes.length) {
        const latest = changes[changes.length - 1]
        setTabNotice(noticeForChange(latest.to, latest.ticketNo, t))
        setUnread((n) => n + changes.length)
        setAlertIds((ids) => [...new Set([...ids, ...changes.map((row) => row.id)])])
        setFormNotices((prev) => {
          const next = [...prev]
          for (const change of changes) {
            const item: FormNotice = { id: change.id, ticketNo: change.ticketNo, to: change.to }
            const i = next.findIndex((row) => row.id === change.id)
            if (i >= 0) next[i] = item
            else next.push(item)
          }
          return next
        })
      }
    } catch {
      /* keep the form usable even if the list fails */
    }
  }, [hostname, secret, t])

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
        if (!cancelled) setError(friendlyError(e instanceof Error ? e.message : String(e), t))
      })
      .finally(() => {
        if (!cancelled) setDetecting(false)
      })
    return () => {
      cancelled = true
    }
  }, [hintedHost, secret, t])

  useEffect(() => {
    void loadTickets()
  }, [loadTickets])

  useEffect(() => {
    if (!hostname && !secret) return
    const timer = window.setInterval(() => {
      void loadTickets()
    }, 12000)
    return () => window.clearInterval(timer)
  }, [hostname, secret, loadTickets])

  useEffect(() => {
    const apply = (notice: string | null) => {
      document.title = helpFormDocumentTitle(baseTitle, notice, unread)
    }
    apply(tabNotice)
    if (!tabNotice || unread <= 0) return
    const timer = window.setInterval(() => {
      blinkOn.current = !blinkOn.current
      apply(blinkOn.current ? tabNotice : null)
    }, 1600)
    const stopBlink = () => {
      setTabNotice(null)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') stopBlink()
    }
    window.addEventListener('focus', stopBlink)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', stopBlink)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [baseTitle, tabNotice, unread])

  useEffect(() => {
    return () => {
      document.title = baseTitle
    }
  }, [baseTitle])

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
      await loadTickets()
    } catch (e) {
      setError(friendlyError(e instanceof Error ? e.message : String(e), t))
    } finally {
      setSending(false)
    }
  }

  const ticketLabel = result?.request_id != null ? helpTicketNo(result.ticket_no, result.request_id) : null
  const person = context?.requester_hint ? displayName(context.requester_hint) : ''
  const pcName = shortPcName(context?.hostname || hintedHost)
  const place = (context?.location || '').trim()
  const blocked = Boolean(error && !context)
  const hello = helpGreeting(person, t(dayPartGreetingKey()))
  const showTickets = !blocked
  const selectedTicket = tickets.find((row) => row.id === selectedId) ?? null
  const closeModal = useCallback(() => setSelectedId(null), [])

  const openTicket = useCallback((id: number) => {
    setSelectedId(id)
    setUnread(0)
    setTabNotice(null)
    setAlertIds((ids) => ids.filter((rowId) => rowId !== id))
    setFormNotices((rows) => rows.filter((row) => row.id !== id))
  }, [])

  const dismissNotice = useCallback((id: number) => {
    setFormNotices((rows) => rows.filter((row) => row.id !== id))
  }, [])

  return (
    <main className="help-page">
      <div className="help-scene" aria-hidden>
        <span className="help-mesh" />
        <span className="help-glow help-glow-a" />
        <span className="help-glow help-glow-b" />
      </div>
      <div className={`help-shell${showTickets ? ' has-tickets' : ''}`}>
        <section className="help-card">
          <header className="help-card-head">
            <div className="help-lang login-seg" role="group" aria-label={t('prefs.language')}>
              <button
                type="button"
                onClick={() => setLocale('ru')}
                aria-pressed={locale === 'ru'}
                className={`login-seg-btn ${locale === 'ru' ? 'login-seg-btn-on' : ''}`}
              >
                RU
              </button>
              <button
                type="button"
                onClick={() => setLocale('en')}
                aria-pressed={locale === 'en'}
                className={`login-seg-btn ${locale === 'en' ? 'login-seg-btn-on' : ''}`}
              >
                EN
              </button>
            </div>
            <div className="help-brand">
              <CoraxLogo variant="wordmark" alt="Corax" className="help-wordmark" />
            </div>
            <h1 className="help-title">{hello}</h1>
            <p className="help-lead">{t('ticketHandler.helpForm.lead')}</p>
            {detecting && !pcName ? (
              <p className="help-device is-wait">{t('ticketHandler.helpForm.detecting')}</p>
            ) : null}
            {pcName ? (
              <p className="help-device">
                {t('ticketHandler.helpForm.fromPc')} <strong>{pcName}</strong>
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

            {formNotices.length > 0 && !blocked ? (
              <ul className="help-notices" aria-live="polite">
                {formNotices.map((notice) => (
                  <li key={notice.id} className={`help-notice is-${notice.to}`}>
                    <button type="button" className="help-notice-body" onClick={() => openTicket(notice.id)}>
                      <p className="help-notice-title">{noticeForChange(notice.to, notice.ticketNo, t)}</p>
                      <p className="help-notice-text">{noticeHint(notice.to, t)}</p>
                    </button>
                    <button
                      type="button"
                      className="help-notice-dismiss"
                      aria-label={t('common.close')}
                      onClick={() => dismissNotice(notice.id)}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {result && !blocked ? (
              <div className="help-success help-success-banner" role="status">
                <p className="help-success-title">
                  {ticketLabel
                    ? t('ticketHandler.helpForm.acceptedWithNo', { ticket: ticketLabel })
                    : t('ticketHandler.helpForm.accepted')}
                </p>
                <p className="help-success-text">{t('ticketHandler.helpForm.acceptedHint')}</p>
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
                  <span>{t('ticketHandler.helpForm.titleLabel')}</span>
                  <input
                    required
                    minLength={3}
                    name="title"
                    value={titleDraft}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    placeholder={t('ticketHandler.helpForm.titlePlaceholder')}
                    autoComplete="off"
                    autoFocus
                  />
                </label>

                <label className="help-field help-field-quiet">
                  <span>
                    {t('ticketHandler.helpForm.detailsLabel')}{' '}
                    <em>{t('ticketHandler.helpForm.detailsOptional')}</em>
                  </span>
                  <textarea
                    name="description"
                    placeholder={t('ticketHandler.helpForm.detailsPlaceholder')}
                    rows={6}
                  />
                </label>

                <button type="submit" className="help-submit" disabled={sending}>
                  {sending ? (
                    <>
                      <span className="help-spinner" aria-hidden />
                      {t('ticketHandler.helpForm.sending')}
                    </>
                  ) : (
                    t('ticketHandler.helpForm.submit')
                  )}
                </button>
              </form>
            ) : null}
          </div>
        </section>

        {showTickets ? (
          <HelpTicketList
            tickets={tickets}
            selectedId={selectedId}
            highlightId={result?.request_id ?? null}
            alertIds={alertIds}
            onSelect={openTicket}
          />
        ) : null}
      </div>
      {selectedTicket ? (
        <HelpTicketModal ticket={selectedTicket} onClose={closeModal} />
      ) : null}
    </main>
  )
}

function HelpTicketList({
  tickets,
  selectedId,
  highlightId,
  alertIds,
  onSelect,
}: {
  tickets: TicketHandlerPublicTicket[]
  selectedId: number | null
  highlightId: number | null
  alertIds: number[]
  onSelect: (id: number) => void
}) {
  const { t } = useLocale()

  return (
    <aside className="help-tickets" aria-live="polite">
      <h2 className="help-tickets-title">{t('ticketHandler.helpForm.myTickets')}</h2>
      {tickets.length === 0 ? (
        <p className="help-tickets-empty">{t('ticketHandler.helpForm.myTicketsEmpty')}</p>
      ) : (
        <ul className="help-ticket-list">
          {tickets.map((row) => {
            const phase = helpTicketPhase(row.status, row.assignees)
            const selected = selectedId === row.id
            const alert = alertIds.includes(row.id)
            const ticketNo = helpTicketNo(row.ticket_no, row.id)
            return (
              <li
                key={row.id}
                className={`help-ticket-item${selected ? ' is-open' : ''}${alert ? ' is-alert' : ''}`}
              >
                <button
                  type="button"
                  className={`help-ticket${highlightId === row.id ? ' is-new' : ''}${
                    phase === 'done' || phase === 'cancelled' ? ' is-done' : ''
                  }${selected ? ' is-selected' : ''}${alert ? ' is-alert' : ''}`}
                  aria-haspopup="dialog"
                  aria-label={t('ticketHandler.helpForm.selectTicket', { ticket: ticketNo })}
                  onClick={() => onSelect(row.id)}
                >
                  <div className="help-ticket-top">
                    <span className="help-ticket-no">{ticketNo}</span>
                    <span className={`help-ticket-status is-${phase}`}>{phaseLabel(phase, t)}</span>
                  </div>
                  <p className="help-ticket-title">{row.title}</p>
                  <span className="help-ticket-chevron" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

function HelpTicketModal({
  ticket,
  onClose,
}: {
  ticket: TicketHandlerPublicTicket
  onClose: () => void
}) {
  const { t, locale } = useLocale()
  const dialogRef = useRef<HTMLDivElement>(null)
  const phase = helpTicketPhase(ticket.status, ticket.assignees)
  const ticketNo = helpTicketNo(ticket.ticket_no, ticket.id)
  const who = helpTicketAssigneesLine(ticket.assignees)
  const opened = helpTicketWhen(ticket.opened_at, locale)
  const closedIso =
    ticket.closed_at || (phase === 'done' || phase === 'cancelled' ? ticket.updated_at : null)
  const closed = helpTicketWhen(closedIso, locale)

  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return createPortal(
    <div className="help-modal-layer" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="help-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-ticket-modal-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="help-modal-head">
          <div>
            <p className="help-ticket-no">{ticketNo}</p>
            <h2 id="help-ticket-modal-title" className="help-modal-title">
              {ticket.title}
            </h2>
          </div>
          <span className={`help-ticket-status is-${phase}`}>{phaseLabel(phase, t)}</span>
        </header>
        <ol className="help-ticket-steps">
          <li className="help-ticket-step is-on">{t('ticketHandler.helpForm.stepAccepted')}</li>
          <li className={`help-ticket-step${phase === 'taken' || phase === 'done' ? ' is-on' : ''}`}>
            {t('ticketHandler.helpForm.stepTaken')}
          </li>
          <li className={`help-ticket-step${phase === 'done' ? ' is-on' : ''}`}>
            {t('ticketHandler.helpForm.stepDone')}
          </li>
        </ol>
        {phase === 'cancelled' ? (
          <p className="help-ticket-meta">{t('ticketHandler.helpForm.statusCancelled')}</p>
        ) : null}
        {who ? (
          <p className="help-ticket-meta">{t('ticketHandler.helpForm.takenBy', { who })}</p>
        ) : phase === 'waiting' ? (
          <p className="help-ticket-meta">{t('ticketHandler.helpForm.notTaken')}</p>
        ) : null}
        <dl className="help-ticket-dates">
          <div>
            <dt>{t('ticketHandler.helpForm.openedLabel')}</dt>
            <dd>{opened || '—'}</dd>
          </div>
          <div>
            <dt>{t('ticketHandler.helpForm.closedLabel')}</dt>
            <dd>{closed || t('ticketHandler.helpForm.notClosed')}</dd>
          </div>
        </dl>
        <button type="button" className="help-modal-close" onClick={onClose}>
          {t('common.close')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
