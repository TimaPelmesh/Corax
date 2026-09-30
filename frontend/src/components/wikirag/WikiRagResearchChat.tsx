import { useEffect, useRef, useState } from 'react'
import { streamWikiRagResearch } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { loadWikiRagLmSettings } from '../../lib/wikiragLmSettings'
import { cleanAssistantText, streamDisplayText } from '../../lib/wikiragStreamDisplay'
import { IconSend } from '../icons'
import { WikiRagMarkdown } from './WikiRagMarkdown'

const STORAGE_KEY = 'inventory-wikirag-research-v1'

type ResearchSource = {
  filename?: string
  label?: string
  excerpt?: string
}

type ResearchTurn = {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
  sources?: ResearchSource[]
}

function loadTurns(): ResearchTurn[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as { turns?: ResearchTurn[] }
    return Array.isArray(data.turns) ? data.turns : []
  } catch {
    return []
  }
}

function saveTurns(turns: ResearchTurn[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ turns: turns.slice(-40) }))
  } catch {
    /* квота браузера */
  }
}

function historyForLm(turns: ResearchTurn[]) {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  let pending: { role: 'user'; content: string } | null = null
  for (const turn of turns) {
    if (!turn.content.trim() || turn.error) continue
    if (turn.role === 'user') {
      pending = { role: 'user', content: turn.content }
      continue
    }
    if (pending) {
      out.push(pending, { role: 'assistant', content: turn.content })
      pending = null
    }
  }
  return out.slice(-2)
}

export function WikiRagResearchChat() {
  const t = useT()
  const [turns, setTurns] = useState<ResearchTurn[]>(() => loadTurns())
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    saveTurns(turns)
  }, [turns])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns, sending])

  async function send(text?: string) {
    const q = (text ?? input).trim()
    if (!q || sending) return
    setInput('')
    const history = historyForLm(turns)
    setTurns((prev) => [...prev, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setSending(true)
    const lm = loadWikiRagLmSettings()
    try {
      let received = false
      await streamWikiRagResearch(
        {
          message: q,
          history,
          lm_base_url: lm.baseUrl,
          lm_model: lm.model || null,
        },
        {
          onDelta: (delta) => {
            setTurns((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (!last || last.role !== 'assistant') return prev
              next[next.length - 1] = { ...last, content: last.content + delta }
              return next
            })
          },
          onDone: (res) => {
            received = true
            const sources = (res.parsed?.sources || res.meta?.sources || []) as ResearchSource[]
            const answer = (res.parsed?.answer || '').trim()
            setTurns((prev) => {
              const next = [...prev]
              const last = next[next.length - 1]
              if (!last || last.role !== 'assistant') return prev
              const textOut = answer && !answer.startsWith('{') ? answer : last.content
              next[next.length - 1] = {
                ...last,
                content: textOut || t('wikirag.research.emptyModel'),
                sources: sources.filter((s) => s.filename || s.label),
              }
              return next
            })
          },
        },
      )
      if (!received) {
        setTurns((prev) => [
          ...prev.slice(0, -1),
          { role: 'assistant', content: t('wikirag.research.failed'), error: true },
        ])
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('wikirag.research.failed')
      setTurns((prev) => [...prev.slice(0, -1), { role: 'assistant', content: msg, error: true }])
    } finally {
      setSending(false)
    }
  }

  const samples = [t('wikirag.research.sample1'), t('wikirag.research.sample2'), t('wikirag.research.sample3')]

  return (
    <div className="flex h-full min-h-0 flex-col px-3.5 py-3 text-[var(--color-fg)] sm:px-5">
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--color-border)] pb-2.5">
        <p className="min-w-0 flex-1 truncate text-sm font-semibold">{t('wikirag.research.title')}</p>
        <span className="shrink-0 rounded-md bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
          {t('wikirag.research.badge')}
        </span>
        <button
          type="button"
          disabled={!turns.length || sending}
          onClick={() => setTurns([])}
          className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-muted)] disabled:opacity-30"
        >
          {t('wikirag.chat.clear')}
        </button>
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
                    onClick={() => void send(hint)}
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((turn, index) => {
              const streaming = sending && index === turns.length - 1 && turn.role === 'assistant'
              const raw = turn.role === 'user' ? turn.content : turn.content
              const streamView = streaming ? streamDisplayText(raw, { streaming: true }) : null
              const display = turn.role === 'user' || turn.error ? raw : streaming ? streamView?.text || '' : cleanAssistantText(raw)
              return (
                <div key={`${index}-${turn.role}`} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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
                      <div className="rounded-2xl rounded-bl-md bg-[var(--color-bg-muted)]/55 px-3.5 py-2.5">
                        {streaming && !display.trim() ? (
                          <p className="text-[13px] text-[var(--color-fg-muted)]">{t('wikirag.research.searching')}</p>
                        ) : (
                          display ? <WikiRagMarkdown text={display} /> : null
                        )}
                      </div>
                    )}
                    {turn.sources?.length ? (
                      <ul className="mt-2 space-y-1.5">
                        {turn.sources.slice(0, 6).map((source) => {
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
          void send()
        }}
      >
        <div className="flex items-end gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-muted)]/40 px-2 py-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            placeholder={t('wikirag.research.placeholder')}
            className="min-h-[2.6rem] flex-1 resize-none bg-transparent px-2 py-1 text-[13px] outline-none"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-primary)] text-white disabled:opacity-40"
            aria-label={t('wikirag.chat.send')}
          >
            <IconSend className="h-4 w-4" />
          </button>
        </div>
      </form>
    </div>
  )
}
