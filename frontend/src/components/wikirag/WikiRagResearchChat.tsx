import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT, type MessageKey } from '../../i18n/LocaleContext'
import {
  isWikiRagResearchPending,
  loadWikiRagResearchChats,
  newWikiRagResearchSession,
  saveWikiRagResearchChats,
  sendWikiRagResearchMessage,
  subscribeWikiRagResearchChats,
  type WikiRagResearchSession,
  type WikiRagResearchTurn,
} from '../../lib/wikiragResearchStore'
import { cleanAssistantText, streamDisplayText } from '../../lib/wikiragStreamDisplay'
import { IconClose, IconMenu, IconSend } from '../icons'
import { WikiRagStreamAnswer } from './WikiRagStreamAnswer'

function assistantRawText(t: WikiRagResearchTurn): string {
  if (t.role !== 'assistant' || t.error) return t.content
  const fromParsed = t.parsed?.answer?.trim()
  if (fromParsed && !fromParsed.startsWith('{') && !fromParsed.includes('"answer"')) return fromParsed
  return t.content
}

function progressCopy(
  t: (key: MessageKey, vars?: Record<string, string | number>) => string,
  turn: WikiRagResearchTurn,
): { title: string; detail: string } {
  const p = turn.progress
  if (!p) return { title: t('wikirag.research.searching'), detail: '' }
  if (p.stage === 'open' && p.title) {
    return {
      title: t('wikirag.research.opening', { title: p.title }),
      detail: p.index && p.total ? `${p.index} / ${p.total}` : '',
    }
  }
  if (p.stage === 'found') {
    return { title: t('wikirag.research.found', { n: p.found ?? 0 }), detail: '' }
  }
  if (p.stage === 'ready') {
    return { title: t('wikirag.research.ready', { n: p.pages ?? turn.opened?.length ?? 0 }), detail: '' }
  }
  if (p.stage === 'generate') {
    return { title: t('wikirag.research.generating'), detail: '' }
  }
  if (p.query) return { title: t('wikirag.research.searchingQuery', { query: p.query }), detail: '' }
  return { title: p.label || t('wikirag.research.searching'), detail: '' }
}

export function WikiRagResearchChat() {
  const t = useT()
  const fallbackTitle = t('wikirag.research.newSessionTitle')
  const emptyModelResponse = t('wikirag.research.emptyModel')
  const errorFallback = t('wikirag.research.failed')

  const [sessions, setSessions] = useState<WikiRagResearchSession[]>(
    () => loadWikiRagResearchChats(fallbackTitle).sessions,
  )
  const [activeId, setActiveId] = useState(() => loadWikiRagResearchChats(fallbackTitle).activeId)
  const [input, setInput] = useState('')
  const [pendingTick, setPendingTick] = useState(0)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const turns = useMemo(() => active?.turns ?? [], [active])
  const sending = Boolean(active && isWikiRagResearchPending(active.id))
  void pendingTick

  const hydrate = useCallback(() => {
    const st = loadWikiRagResearchChats(fallbackTitle)
    setSessions(st.sessions)
    setActiveId((id) => (st.sessions.some((s) => s.id === id) ? id : st.activeId))
    setPendingTick((n) => n + 1)
  }, [fallbackTitle])

  useEffect(() => {
    saveWikiRagResearchChats(sessions, activeId)
  }, [sessions, activeId])

  useEffect(() => subscribeWikiRagResearchChats(hydrate), [hydrate])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, sending, activeId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(140, Math.max(44, el.scrollHeight))}px`
  }, [input])

  function persist(nextSessions: WikiRagResearchSession[], nextActive: string) {
    setSessions(nextSessions)
    setActiveId(nextActive)
    saveWikiRagResearchChats(nextSessions, nextActive)
  }

  function addSession() {
    const s = newWikiRagResearchSession(fallbackTitle)
    persist([...sessions, s], s.id)
    setInput('')
  }

  function clearActive() {
    if (!active || sending) return
    persist(
      sessions.map((s) =>
        s.id === active.id ? { ...s, turns: [], title: fallbackTitle, updatedAt: Date.now() } : s,
      ),
      active.id,
    )
    setInput('')
  }

  function closeSession(id: string) {
    if (isWikiRagResearchPending(id)) return
    if (sessions.length <= 1) {
      const s = newWikiRagResearchSession(fallbackTitle)
      persist([s], s.id)
      return
    }
    const next = sessions.filter((s) => s.id !== id)
    persist(next, activeId === id ? next[0].id : activeId)
  }

  function send(text?: string) {
    const q = (text ?? input).trim()
    if (!q || !active || sending) return
    setInput('')
    sendWikiRagResearchMessage({
      sessionId: active.id,
      message: q,
      fallbackTitle,
      emptyModelResponse,
      errorFallback,
    })
    setPendingTick((n) => n + 1)
  }

  const lastAssistantIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'assistant') return i
    }
    return -1
  })()

  const samples = [t('wikirag.research.sample1'), t('wikirag.research.sample2'), t('wikirag.research.sample3')]

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden text-[var(--color-fg)]">
      {sessionsOpen ? (
        <button
          type="button"
          className="absolute inset-0 z-20 bg-slate-950/30 lg:hidden"
          onClick={() => setSessionsOpen(false)}
          aria-label={t('common.close')}
        />
      ) : null}

      <aside
        className={`absolute inset-y-0 left-0 z-30 flex w-[min(17rem,86vw)] shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 transition-transform lg:static lg:z-auto lg:w-64 lg:translate-x-0 ${
          sessionsOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 pb-2">
          <button
            type="button"
            onClick={addSession}
            className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 text-[12px] font-semibold text-amber-800 transition hover:bg-amber-500/20 dark:text-amber-200"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M8 3.2v9.6M3.2 8h9.6" strokeLinecap="round" />
            </svg>
            {t('wikirag.chat.newChat')}
          </button>
          <button
            type="button"
            onClick={() => setSessionsOpen(false)}
            className="rounded-lg p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] lg:hidden"
            aria-label={t('common.close')}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto py-1 [scrollbar-gutter:stable]">
          {sessions
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setActiveId(s.id)
                  setInput('')
                  setSessionsOpen(false)
                }}
                className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                  s.id === activeId
                    ? 'bg-amber-500/15 text-amber-900 dark:text-amber-100'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]'
                }`}
                title={s.title}
              >
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{s.title}</span>
                {isWikiRagResearchPending(s.id) ? <span className="shrink-0 text-xs opacity-60">…</span> : null}
                {sessions.length > 1 && !isWikiRagResearchPending(s.id) ? (
                  <span
                    role="button"
                    tabIndex={0}
                    className="invisible shrink-0 rounded p-0.5 text-[var(--color-fg-subtle)] opacity-0 transition-[opacity,color] hover:text-[var(--color-fg)] focus:visible focus:opacity-100 group-hover:visible group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation()
                      closeSession(s.id)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.stopPropagation()
                        closeSession(s.id)
                      }
                    }}
                    aria-label={t('wikirag.chat.closeChat')}
                  >
                    ×
                  </span>
                ) : null}
              </button>
            ))}
        </div>
        <button
          type="button"
          onClick={clearActive}
          disabled={!turns.length || sending}
          className="mt-1 shrink-0 rounded-lg px-3 py-2 text-left text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)] disabled:opacity-30"
        >
          {t('wikirag.chat.clear')}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col px-3.5 py-3 sm:px-5">
        <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] pb-2.5">
          <button
            type="button"
            onClick={() => setSessionsOpen(true)}
            className="rounded-lg p-1.5 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] lg:hidden"
            aria-label={t('wikirag.chat.newChat')}
          >
            <IconMenu className="h-4 w-4" />
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-semibold">{active?.title || fallbackTitle}</p>
          <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
            {t('wikirag.research.badge')}
          </span>
        </header>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3 [scrollbar-gutter:stable]">
          <div className="mx-auto w-full max-w-4xl space-y-3.5">
            {turns.length === 0 && !sending ? (
              <div className="mx-auto max-w-2xl space-y-4 pt-[min(8vh,4rem)]">
                <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{t('wikirag.research.hint')}</p>
                <div className="flex flex-col gap-1.5">
                  {samples.map((hint) => (
                    <button
                      key={hint}
                      type="button"
                      className="rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-bg-muted)]/50 px-3 py-2 text-left text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-primary)]/40 hover:text-[var(--color-fg)]"
                      onClick={() => send(hint)}
                    >
                      {hint}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              turns.map((turn, index) => {
                const streaming = sending && index === lastAssistantIdx && turn.role === 'assistant'
                const raw = turn.role === 'user' ? turn.content : assistantRawText(turn)
                const streamView = streaming ? streamDisplayText(raw, { streaming: true }) : null
                const display =
                  turn.role === 'user' || turn.error ? raw : streaming ? streamView?.text || '' : cleanAssistantText(raw)
                const showStatus = Boolean(streaming && (streamView?.waiting || !display.trim()))
                const copy = progressCopy(t, turn)
                const sources = turn.parsed?.sources || []

                return (
                  <div key={`${activeId}-${index}-${turn.role}`} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={
                        turn.role === 'user'
                          ? 'max-w-[82%] rounded-2xl rounded-br-md bg-[var(--color-primary-muted)] px-3.5 py-2.5 text-[13px] leading-relaxed'
                          : 'w-full px-0.5'
                      }
                    >
                      {turn.role === 'user' || turn.error ? (
                        <p className="whitespace-pre-wrap">{display}</p>
                      ) : (
                        <div className="wikirag-msg-in rounded-2xl rounded-bl-md bg-[var(--color-bg-muted)]/55 px-3.5 py-2.5">
                          {showStatus ? (
                            <div className="space-y-2">
                              <p className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--color-fg-muted)]">
                                <span className="wikirag-index-spinner" aria-hidden />
                                {copy.title}
                              </p>
                              {copy.detail ? (
                                <p className="text-[11px] text-[var(--color-fg-subtle)]">{copy.detail}</p>
                              ) : null}
                              {turn.opened?.length ? (
                                <ul className="space-y-1">
                                  {turn.opened.slice(-6).map((title) => (
                                    <li key={title} className="truncate text-[11px] text-[var(--color-fg-muted)]">
                                      {title}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>
                          ) : (
                            <WikiRagStreamAnswer text={display} streaming={streaming} />
                          )}
                        </div>
                      )}
                      {sources.length ? (
                        <ul className="mt-2 space-y-1.5">
                          {sources.slice(0, 8).map((source) => {
                            const href = source.filename || ''
                            const label = source.label || href
                            return (
                              <li key={href || label}>
                                {href.startsWith('http') ? (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer noopener"
                                    className="block truncate rounded-lg border border-[var(--color-border)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-primary)] hover:bg-[var(--color-bg-muted)]"
                                  >
                                    {label}
                                  </a>
                                ) : (
                                  <span className="block truncate text-[11px] text-[var(--color-fg-muted)]">{label}</span>
                                )}
                              </li>
                            )
                          })}
                        </ul>
                      ) : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <form
          className="shrink-0 pt-2"
          onSubmit={(event) => {
            event.preventDefault()
            send()
          }}
        >
          <div className="wikirag-composer flex items-end gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-2.5 py-2 transition-[border-color,box-shadow,background-color] focus-within:border-[var(--color-primary)] focus-within:bg-[var(--color-surface)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_18%,transparent)]">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  send()
                }
              }}
              rows={1}
              placeholder={t('wikirag.research.placeholder')}
              className="wikirag-composer-input max-h-[140px] min-h-[44px] flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-[13px] leading-relaxed outline-none"
              disabled={sending}
            />
            <button
              type="submit"
              disabled={!input.trim() || sending}
              className="mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)] text-white disabled:opacity-40"
              aria-label={t('wikirag.chat.send')}
            >
              <IconSend className="h-[18px] w-[18px]" />
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
