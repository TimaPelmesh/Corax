import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type WikiRagChatParsed, type WikiRagChatResponse } from '../../api'
import { IconClose } from '../icons'

const STORAGE_KEY = 'inventory-wikirag-chats-v1'

type ChatTurn = {
  role: 'user' | 'assistant'
  content: string
  parsed?: WikiRagChatParsed | null
  error?: boolean
  meta?: WikiRagChatResponse['meta']
}

type ChatSession = {
  id: string
  title: string
  turns: ChatTurn[]
  updatedAt: number
}

/** ID чата: randomUUID есть только в secure context (localhost/https), не на http://192.168.x.x */
function newSessionId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16)
    c.getRandomValues(b)
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function newSession(): ChatSession {
  return { id: newSessionId(), title: 'Новый чат', turns: [], updatedAt: Date.now() }
}

function sessionTitle(turns: ChatTurn[]): string {
  const first = turns.find((t) => t.role === 'user' && !t.error)
  if (!first) return 'Новый чат'
  const t = first.content.trim()
  return t.length > 22 ? `${t.slice(0, 22)}…` : t || 'Новый чат'
}

/** Убирает JSON-обёртку от модели (в т.ч. битый JSON с кавычками внутри answer). */
function extractAnswerText(raw: string): string {
  const text = raw.trim()
  if (!text) return '(пустой ответ)'
  try {
    const o = JSON.parse(text) as { answer?: unknown }
    if (typeof o.answer === 'string' && o.answer.trim()) return o.answer.trim()
  } catch {
    /* not valid JSON */
  }
  if (text.includes('"answer"')) {
    const m = text.match(
      /"answer"\s*:\s*"(.+?)"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"/s,
    )
    if (m?.[1]) return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"')
    const m2 = text.match(/"answer"\s*:\s*"(.*)/s)
    if (m2?.[1]) {
      let tail = m2[1]
      const cut = tail.split(/"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"/)[0]
      tail = cut ?? tail
      return tail.replace(/"\s*\}\s*$/, '').replace(/\\n/g, '\n').replace(/\\"/g, '"').trim()
    }
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    return text
      .replace(/^\{\s*"answer"\s*:\s*"?/i, '')
      .replace(/"\s*,\s*"(?:confidence|sources)[\s\S]*$/i, '')
      .replace(/"\s*\}\s*$/, '')
      .trim()
  }
  return text
}

function assistantDisplayText(t: ChatTurn): string {
  if (t.role !== 'assistant' || t.error) return t.content
  const fromParsed = t.parsed?.answer?.trim()
  if (fromParsed && !fromParsed.startsWith('{')) return fromParsed
  const c = t.content.trim()
  if (c.startsWith('{') || c.includes('"answer"')) return extractAnswerText(c)
  return t.content
}

function answerFromResponse(res: WikiRagChatResponse): string {
  const parsedAns = res.parsed?.answer?.trim()
  if (parsedAns && !parsedAns.startsWith('{') && !parsedAns.includes('"answer"')) return parsedAns
  return extractAnswerText(res.raw ?? parsedAns ?? '')
}

function historyForLm(turns: ChatTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  let pendingUser: { role: 'user'; content: string } | null = null
  for (const t of turns) {
    if (!t.content.trim() || t.error) continue
    if (t.role === 'user') {
      pendingUser = { role: 'user', content: t.content }
      continue
    }
    if (pendingUser) {
      out.push(pendingUser, { role: 'assistant', content: assistantDisplayText(t) })
      pendingUser = null
    }
  }
  return out.slice(-6)
}

function loadSessions(): { sessions: ChatSession[]; activeId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const s = newSession()
      return { sessions: [s], activeId: s.id }
    }
    const data = JSON.parse(raw) as { sessions?: ChatSession[]; activeId?: string }
    const sessions = (data.sessions ?? []).filter((s) => s?.id)
    if (!sessions.length) {
      const s = newSession()
      return { sessions: [s], activeId: s.id }
    }
    const activeId = sessions.some((s) => s.id === data.activeId) ? data.activeId! : sessions[0].id
    return { sessions, activeId }
  } catch {
    const s = newSession()
    return { sessions: [s], activeId: s.id }
  }
}

function saveSessions(sessions: ChatSession[], activeId: string) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, activeId }))
}

export function WikiRagChat({
  onClose,
  onOpenDocument,
}: {
  onClose?: () => void
  onOpenDocument?: (id: number) => void
}) {
  const initial = loadSessions()
  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions)
  const [activeId, setActiveId] = useState(initial.activeId)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [lmOk, setLmOk] = useState<boolean | null>(null)
  const [lmDetail, setLmDetail] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const turns = active?.turns ?? []

  useEffect(() => {
    saveSessions(sessions, activeId)
  }, [sessions, activeId])

  const updateActive = useCallback((patch: (s: ChatSession) => ChatSession) => {
    setSessions((list) =>
      list.map((s) => {
        if (s.id !== activeId) return s
        const next = patch(s)
        return { ...next, title: sessionTitle(next.turns), updatedAt: Date.now() }
      }),
    )
  }, [activeId])

  const checkLm = useCallback(async () => {
    try {
      const st = await api.wikiRagLmStudioStatus()
      setLmOk(st.ok)
      setLmDetail(
        st.ok ? (st.models[0] ?? st.detail ?? 'Сервер доступен') : (st.detail ?? 'Нет связи'),
      )
    } catch {
      setLmOk(false)
      setLmDetail('Не удалось проверить LM Studio')
    }
  }, [])

  useEffect(() => {
    void checkLm()
  }, [checkLm])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, sending, activeId])

  function addSession() {
    const s = newSession()
    setSessions((list) => [...list, s])
    setActiveId(s.id)
    setInput('')
  }

  function clearActive() {
    updateActive((s) => ({ ...s, turns: [], title: 'Новый чат' }))
    setInput('')
  }

  function closeSession(id: string) {
    setSessions((list) => {
      if (list.length <= 1) {
        const s = newSession()
        setActiveId(s.id)
        return [s]
      }
      const next = list.filter((s) => s.id !== id)
      if (activeId === id) setActiveId(next[0].id)
      return next
    })
  }

  async function send() {
    const q = input.trim()
    if (!q || sending || !active) return
    setInput('')
    setSending(true)
    updateActive((s) => ({ ...s, turns: [...s.turns, { role: 'user', content: q }] }))
    try {
      const history = historyForLm(turns)
      const res = await api.wikiRagChat({ message: q, document_ids: null, history })
      if (!res.ok) {
        const msg = res.error ?? 'Ошибка LM Studio'
        updateActive((s) => ({
          ...s,
          turns: [...s.turns, { role: 'assistant', content: msg, error: true, meta: res.meta }],
        }))
        return
      }
      const parsed = res.parsed
      const text = answerFromResponse(res)
      updateActive((s) => ({
        ...s,
        turns: [...s.turns, { role: 'assistant', content: text, parsed, meta: res.meta }],
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка'
      updateActive((s) => ({
        ...s,
        turns: [...s.turns, { role: 'assistant', content: msg, error: true }],
      }))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-neutral-100 pb-2">
        <div>
          <h2 className="text-sm font-semibold text-neutral-950">LM Studio</h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => void checkLm()}
            title={lmDetail ?? undefined}
            className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
              lmOk === true
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : lmOk === false
                  ? 'border-amber-200 bg-amber-50 text-amber-900'
                  : 'border-neutral-200 bg-neutral-50 text-neutral-600'
            }`}
          >
            {lmOk === null ? '…' : lmOk ? 'OK' : 'OFF'}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-neutral-500 hover:bg-neutral-100"
              aria-label="Свернуть"
            >
              <IconClose className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      {lmDetail ? (
        <p className={`mt-1 truncate text-[10px] ${lmOk ? 'text-slate-400' : 'text-amber-800'}`}>
          {lmDetail}
        </p>
      ) : null}

      <div className="mt-2 flex items-center gap-1">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-0.5">
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                setActiveId(s.id)
                setInput('')
              }}
              className={`group flex max-w-[7rem] shrink-0 items-center gap-0.5 rounded-lg border px-2 py-1 text-[10px] font-medium ${
                s.id === activeId
                  ? 'border-red-200 bg-red-50 text-red-900'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50'
              }`}
              title={s.title}
            >
              <span className="truncate">{s.title}</span>
              {sessions.length > 1 ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="ml-0.5 rounded px-0.5 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
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
                  aria-label="Закрыть чат"
                >
                  ×
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={addSession}
          className="shrink-0 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-bold text-neutral-700 hover:bg-neutral-50"
          title="Новый чат"
        >
          +
        </button>
      </div>

      <div className="mt-1 flex gap-1">
        <button
          type="button"
          onClick={clearActive}
          disabled={!turns.length}
          className="rounded-md border border-neutral-200 px-2 py-0.5 text-[10px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-40"
        >
          Очистить
        </button>
      </div>

      <div
        ref={scrollRef}
        className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-neutral-200/80 bg-neutral-50/60 p-2"
      >
        {turns.length === 0 ? (
          <p className="text-xs text-slate-500">Задайте вопрос по загруженным документам.</p>
        ) : (
          turns.map((t, i) => (
            <div
              key={i}
              className={`rounded-lg px-2.5 py-2 text-xs ${
                t.role === 'user'
                  ? 'ml-3 bg-red-50 text-neutral-900'
                  : t.error
                    ? 'mr-1 border border-amber-200 bg-amber-50/80 text-amber-950'
                    : 'mr-1 border border-neutral-200 bg-white shadow-sm'
              }`}
            >
              <p className="mb-0.5 text-[9px] font-bold uppercase text-slate-400">
                {t.role === 'user' ? 'Вы' : t.error ? 'Ошибка' : 'AI'}
                {t.meta?.mode ? ` · ${t.meta.mode}` : ''}
              </p>
              <p className="whitespace-pre-wrap leading-relaxed">
                {t.role === 'assistant' ? assistantDisplayText(t) : t.content}
              </p>
              {t.parsed?.sources?.length ? (
                <ul className="mt-1.5 space-y-0.5 border-t border-neutral-100 pt-1.5">
                  {t.parsed.sources.map((s, j) => (
                    <li key={j}>
                      <button
                        type="button"
                        className="text-left text-red-700 underline"
                        onClick={() => onOpenDocument?.(s.document_id)}
                      >
                        {s.filename}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))
        )}
        {sending ? <p className="text-[10px] text-slate-500">Думает…</p> : null}
      </div>

      <div className="mt-2 flex gap-1.5">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder="Вопрос…"
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-neutral-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-red-300 focus:ring-1 focus:ring-red-500/30"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <button
          type="button"
          disabled={sending || !input.trim()}
          onClick={() => void send()}
          className="shrink-0 self-end rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          →
        </button>
      </div>
    </div>
  )
}
