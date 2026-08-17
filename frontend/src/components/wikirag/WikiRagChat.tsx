import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { WikiRagChatParsed } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import {
  isWikiRagChatPending,
  loadWikiRagChats,
  newWikiRagSession,
  saveWikiRagChats,
  sendWikiRagChatMessage,
  subscribeWikiRagChats,
  type WikiRagChatSession,
  type WikiRagChatTurn,
} from '../../lib/wikiragChatStore'
import { cleanAssistantText, streamDisplayText } from '../../lib/wikiragStreamDisplay'
import { IconClose, IconFolder, IconMenu, IconSend } from '../icons'
import { WikiRagMarkdown } from './WikiRagMarkdown'

const EMPTY_ANSWER_MARKERS = new Set(['(пустой ответ)'])

function assistantRawText(t: WikiRagChatTurn): string {
  if (t.role !== 'assistant' || t.error) return t.content
  const fromParsed = t.parsed?.answer?.trim()
  if (fromParsed && !EMPTY_ANSWER_MARKERS.has(fromParsed) && !fromParsed.startsWith('{')) {
    if (!fromParsed.includes('"answer"')) return fromParsed
  }
  return t.content
}

function StreamCaret() {
  return (
    <span
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[2px] animate-pulse rounded-sm bg-[var(--color-primary)] align-text-bottom"
      aria-hidden
    />
  )
}

function WikiRagSources({
  sources,
  onOpenDocument,
}: {
  sources: NonNullable<WikiRagChatParsed['sources']>
  onOpenDocument?: (id: number) => void
}) {
  const t = useT()
  const tableLabels: Record<string, string> = {
    computers: 'ПК',
    hardware: 'Железо',
    software: 'ПО',
    software_stats: 'Статистика ПО',
    users: 'Пользователи',
    printers: 'Принтеры',
    network: 'Сеть',
    tickets: 'Заявки',
    tags: 'Теги',
    readme: 'Индекс',
  }

  return (
    <ol className="m-0 list-none space-y-2 p-0">
      {sources.slice(0, 12).map((source, index) => {
        const fullPath = (source.filename || source.label || '').replace(/\\/g, '/')
        const baseName =
          fullPath.split('/').filter(Boolean).pop() || t('wikirag.chat.sourceFallback')
        const table = source.source_table
          ? tableLabels[source.source_table] || source.source_table
          : ''
        const meta = [fullPath.includes('/') ? fullPath : '', source.hostname, table]
          .filter(Boolean)
          .join(' · ')
        const content = (
          <>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--color-primary-muted)] text-[10px] font-bold tabular-nums text-[var(--color-primary)]">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-[var(--color-fg)]">
                {baseName}
              </span>
              {meta ? (
                <span className="mt-0.5 block truncate text-[10px] text-[var(--color-fg-subtle)]">
                  {meta}
                </span>
              ) : null}
              {source.excerpt ? (
                <span className="mt-1.5 line-clamp-3 block text-[11px] leading-relaxed text-[var(--color-fg-muted)]">
                  {source.excerpt}
                </span>
              ) : null}
            </span>
          </>
        )
        return (
          <li key={`${source.document_id || 'source'}-${index}`}>
            {source.document_id ? (
              <button
                type="button"
                className="flex w-full items-start gap-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 text-left transition hover:bg-[var(--color-bg-muted)]"
                onClick={() => onOpenDocument?.(source.document_id)}
              >
                {content}
              </button>
            ) : (
              <div className="flex items-start gap-2.5 rounded-xl border border-[var(--color-border)] px-3 py-2.5">
                {content}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function WikiRagChat({
  onClose,
  onOpenDocument,
  onOpenKnowledge,
  knowledgeCount,
}: {
  onClose?: () => void
  onOpenDocument?: (id: number) => void
  onOpenKnowledge?: () => void
  knowledgeCount?: number
}) {
  const t = useT()
  const fallbackTitle = t('wikirag.chat.newSessionTitle')
  const emptyModelResponse = t('wikirag.chat.emptyModelResponse')
  const errorFallback = t('wikirag.chat.lmError')

  const [sessions, setSessions] = useState<WikiRagChatSession[]>(() => loadWikiRagChats(fallbackTitle).sessions)
  const [activeId, setActiveId] = useState(() => loadWikiRagChats(fallbackTitle).activeId)
  const [input, setInput] = useState('')
  const [pendingTick, setPendingTick] = useState(0)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sourcesFor, setSourcesFor] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const turns = useMemo(() => active?.turns ?? [], [active])
  const sending = Boolean(active && isWikiRagChatPending(active.id))
  void pendingTick

  const hydrate = useCallback(() => {
    const st = loadWikiRagChats(fallbackTitle)
    setSessions(st.sessions)
    setActiveId((id) => (st.sessions.some((s) => s.id === id) ? id : st.activeId))
    setPendingTick((n) => n + 1)
  }, [fallbackTitle])

  useEffect(() => {
    saveWikiRagChats(sessions, activeId)
  }, [sessions, activeId])

  useEffect(() => subscribeWikiRagChats(hydrate), [hydrate])

  useEffect(() => {
    if (sourcesFor === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSourcesFor(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sourcesFor])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [turns, sending, activeId])

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(140, Math.max(44, el.scrollHeight))}px`
  }, [input])

  function persist(nextSessions: WikiRagChatSession[], nextActive: string) {
    setSessions(nextSessions)
    setActiveId(nextActive)
    saveWikiRagChats(nextSessions, nextActive)
  }

  function addSession() {
    const s = newWikiRagSession(fallbackTitle)
    persist([...sessions, s], s.id)
    setInput('')
  }

  function clearActive() {
    if (!active || sending) return
    const next = sessions.map((s) =>
      s.id === active.id ? { ...s, turns: [], title: fallbackTitle, updatedAt: Date.now() } : s,
    )
    persist(next, active.id)
    setInput('')
  }

  function closeSession(id: string) {
    if (isWikiRagChatPending(id)) return
    if (sessions.length <= 1) {
      const s = newWikiRagSession(fallbackTitle)
      persist([s], s.id)
      return
    }
    const next = sessions.filter((s) => s.id !== id)
    const nextActive = activeId === id ? next[0].id : activeId
    persist(next, nextActive)
  }

  function send() {
    const q = input.trim()
    if (!q || !active || sending) return
    setInput('')
    sendWikiRagChatMessage({
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

  const visibleTurns = turns.filter((turn, i) => {
    if (turn.role === 'user' || turn.error) return true
    const streamingThis = sending && i === lastAssistantIdx
    if (streamingThis) return true
    return Boolean(cleanAssistantText(assistantRawText(turn)).trim())
  })
  const sourceTurn = sourcesFor === null ? null : turns[sourcesFor]

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
            className="inline-flex h-8 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-primary)]/25 bg-[var(--color-primary-muted)] px-2.5 text-[12px] font-semibold text-[var(--color-primary)] transition hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-primary)] hover:text-white"
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
                  setSourcesFor(null)
                  setSessionsOpen(false)
                }}
                className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left transition ${
                  s.id === activeId
                    ? 'bg-[var(--color-primary-muted)] text-[var(--color-primary)]'
                    : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]'
                }`}
                title={s.title}
              >
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{s.title}</span>
                {isWikiRagChatPending(s.id) ? <span className="shrink-0 text-xs opacity-60">…</span> : null}
                {sessions.length > 1 && !isWikiRagChatPending(s.id) ? (
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
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-[var(--color-fg)]">
          {active?.title || fallbackTitle}
        </p>
        {onOpenKnowledge ? (
          <button
            type="button"
            onClick={onOpenKnowledge}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--color-border)] px-2 py-1 text-[11px] font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
          >
            <IconFolder className="h-3.5 w-3.5 text-[var(--color-primary)]" />
            <span className="hidden sm:inline">{t('wikirag.library.title')}</span>
            {typeof knowledgeCount === 'number' ? (
              <span className="tabular-nums text-[10px] text-[var(--color-fg-subtle)]">{knowledgeCount}</span>
            ) : null}
          </button>
        ) : null}
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
            aria-label={t('wikirag.chat.collapse')}
          >
            <IconClose className="h-4 w-4" />
          </button>
        ) : null}
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3 pr-0.5 [scrollbar-gutter:stable]">
        <div className="mx-auto w-full max-w-4xl space-y-3.5">
        {visibleTurns.length === 0 && !sending ? (
          <div className="mx-auto max-w-2xl space-y-4 px-0.5 pt-[min(12vh,6rem)]">
            <p className="text-[13px] leading-relaxed text-[var(--color-fg-muted)]">{t('wikirag.chat.emptyHint')}</p>
            <div className="flex flex-col items-stretch gap-1.5">
              {[t('wikirag.chat.sample1'), t('wikirag.chat.sample2'), t('wikirag.chat.sample3')].map((hint) => (
                <button
                  key={hint}
                  type="button"
                  className="rounded-xl border border-[var(--color-border)]/70 bg-[var(--color-bg-muted)]/50 px-3 py-2 text-left text-[12px] text-[var(--color-fg-muted)] transition hover:border-[var(--color-primary)]/40 hover:text-[var(--color-fg)]"
                  onClick={() => setInput(hint)}
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        ) : (
          visibleTurns.map((turn) => {
            const turnIdx = turns.indexOf(turn)
            const isUser = turn.role === 'user'
            const streamingThis = !isUser && sending && turnIdx === lastAssistantIdx
            const raw = isUser ? turn.content : assistantRawText(turn)
            const streamView = !isUser && streamingThis ? streamDisplayText(raw, { streaming: true }) : null
            const display = isUser
              ? raw
              : streamingThis
                ? streamView?.text || ''
                : cleanAssistantText(raw)
            const showThinking = Boolean(streamingThis && (streamView?.waiting || !display.trim()))

            return (
              <div
                key={`${activeId}-${turnIdx}-${turn.role}`}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`min-w-0 ${
                    isUser
                      ? 'max-w-[82%] rounded-2xl rounded-br-md bg-[var(--color-primary-muted)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--color-fg)]'
                      : turn.error
                        ? 'max-w-[88%] rounded-2xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-3.5 py-2.5 text-[13px] leading-relaxed text-[var(--color-fg-muted)]'
                        : 'w-full px-0.5'
                  }`}
                >
                  {isUser || turn.error ? (
                    <p className="whitespace-pre-wrap">{display}</p>
                  ) : (
                    <div className="wikirag-msg-in rounded-2xl rounded-bl-md bg-[var(--color-bg-muted)]/55 px-3.5 py-2.5">
                      {showThinking ? (
                        <p className="inline-flex items-center gap-2 text-[13px] font-medium text-[var(--color-fg-muted)]">
                          <span className="wikirag-index-spinner" aria-hidden />
                          {t('wikirag.chat.thinking')}
                        </p>
                      ) : (
                        <>
                          {display ? <WikiRagMarkdown text={display} /> : null}
                          {streamingThis ? <StreamCaret /> : null}
                        </>
                      )}
                    </div>
                  )}
                  {!isUser && turn.parsed?.sources?.length ? (
                    <button
                      type="button"
                      onClick={() => setSourcesFor(turnIdx)}
                      className="mt-2.5 inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-[11px] font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] hover:text-[var(--color-fg)]"
                    >
                      {t('wikirag.chat.sources')}
                      <span className="rounded-md bg-[var(--color-primary-muted)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--color-primary)]">
                        {turn.parsed.sources.length}
                      </span>
                    </button>
                  ) : null}
                </div>
              </div>
            )
          })
        )}
        </div>
      </div>

      <div className="shrink-0 border-t border-[var(--color-border)] pt-2.5">
        <div className="mx-auto w-full max-w-4xl">
        <div className="wikirag-composer flex items-end gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-2.5 py-2 transition-[border-color,box-shadow,background-color] focus-within:border-[var(--color-primary)] focus-within:bg-[var(--color-surface)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_18%,transparent)]">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={1}
            placeholder={t('wikirag.chat.promptPlaceholder')}
            className="wikirag-composer-input max-h-[140px] min-h-[44px] flex-1 resize-none border-0 bg-transparent px-1.5 py-2 text-[13px] leading-relaxed outline-none ring-0 placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:ring-0 focus-visible:outline-none disabled:opacity-50"
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <button
            type="button"
            disabled={sending || !input.trim()}
            onClick={send}
            className="mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)] text-white shadow-sm outline-none transition hover:bg-[var(--color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/35 disabled:cursor-not-allowed disabled:opacity-35"
            aria-label={t('wikirag.chat.send')}
            title={t('wikirag.chat.send')}
          >
            <IconSend className="h-[18px] w-[18px]" />
          </button>
        </div>
        </div>
      </div>
      </div>
      {sourceTurn?.parsed?.sources?.length
        ? createPortal(
            <div
              className="app-modal-layer wikirag-modal-backdrop fixed inset-0 z-[200] flex justify-end bg-slate-950/35 backdrop-blur-[2px]"
              role="dialog"
              aria-modal
              aria-label={t('wikirag.chat.sources')}
              onClick={() => setSourcesFor(null)}
            >
          <aside
            className="wikirag-drawer flex h-full w-full max-w-[min(32rem,94vw)] flex-col border-l border-[var(--color-border)] bg-[var(--color-bg)] shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <div>
                <h2 className="text-base font-semibold text-[var(--color-fg)]">{t('wikirag.chat.sources')}</h2>
                <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">
                  {sourceTurn.parsed.sources.length}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSourcesFor(null)}
                className="rounded-lg border border-[var(--color-border)] p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)]"
                aria-label={t('common.close')}
              >
                <IconClose className="h-5 w-5" />
              </button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
              <WikiRagSources
                sources={sourceTurn.parsed.sources}
                onOpenDocument={(id) => {
                  setSourcesFor(null)
                  onOpenDocument?.(id)
                }}
              />
            </div>
          </aside>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
