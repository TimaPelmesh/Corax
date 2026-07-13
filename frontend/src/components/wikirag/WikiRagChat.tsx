import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type WikiRagChatParsed, type WikiRagChatResponse } from '../../api'
import { useT } from '../../i18n/LocaleContext'
import { IconClose } from '../icons'

const STORAGE_KEY = 'inventory-wikirag-chats-v1'
const LM_SETTINGS_KEY = 'inventory-wikirag-lm-v1'
const DEFAULT_LM_BASE_URL = 'http://127.0.0.1:1234/v1'

type LmSettings = {
  baseUrl: string
  model: string
  includeCorax: boolean
}

function loadLmSettings(): LmSettings {
  try {
    const raw = localStorage.getItem(LM_SETTINGS_KEY)
    if (!raw) {
      return { baseUrl: DEFAULT_LM_BASE_URL, model: '', includeCorax: true }
    }
    const data = JSON.parse(raw) as Partial<LmSettings>
    return {
      baseUrl: (data.baseUrl || DEFAULT_LM_BASE_URL).trim() || DEFAULT_LM_BASE_URL,
      model: (data.model || '').trim(),
      includeCorax: data.includeCorax !== false,
    }
  } catch {
    return { baseUrl: DEFAULT_LM_BASE_URL, model: '', includeCorax: true }
  }
}

function saveLmSettings(settings: LmSettings) {
  localStorage.setItem(LM_SETTINGS_KEY, JSON.stringify(settings))
}

type ChatTurn = {
  role: 'user' | 'assistant'
  content: string
  parsed?: WikiRagChatParsed | null
  error?: boolean
  meta?: WikiRagChatResponse['meta']
  reveal?: boolean
}

function ThinkingBubble() {
  const t = useT()
  return (
    <div className="wikirag-msg-enter wikirag-thinking mr-1 flex items-center gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--color-primary)_35%,var(--color-border))] bg-[var(--color-primary-muted)] px-3 py-2.5 shadow-sm">
      <div className="flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="inline-block h-2 w-2 rounded-full bg-[var(--color-primary)] motion-safe:animate-bounce"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
      <span className="text-[11px] font-medium text-[var(--color-fg-muted)]">
        {t('wikirag.chat.thinking')}
      </span>
    </div>
  )
}

function TypewriterText({
  text,
  active,
  onComplete,
}: {
  text: string
  active: boolean
  onComplete?: () => void
}) {
  const [shown, setShown] = useState(active ? '' : text)

  useEffect(() => {
    if (!active) {
      setShown(text)
      return
    }
    setShown('')
    let idx = 0
    let timer = 0
    const step = () => {
      const chunk = text.length > 500 ? 4 : text.length > 200 ? 3 : 2
      idx = Math.min(text.length, idx + chunk)
      setShown(text.slice(0, idx))
      if (idx < text.length) {
        const ch = text[idx - 1] ?? ''
        const pause =
          ch === '.' || ch === '!' || ch === '?' ? 55 : ch === ',' || ch === ';' ? 30 : ch === '\n' ? 22 : 16
        timer = window.setTimeout(step, pause)
      } else {
        onComplete?.()
      }
    }
    timer = window.setTimeout(step, 100)
    return () => window.clearTimeout(timer)
  }, [text, active, onComplete])

  return (
    <p className="whitespace-pre-wrap leading-relaxed text-[var(--color-fg)]">
      {shown}
      {active && shown.length < text.length ? (
        <span
          className="ml-0.5 inline-block h-3.5 w-0.5 translate-y-px animate-pulse bg-[var(--color-primary)] align-middle"
          aria-hidden
        />
      ) : null}
    </p>
  )
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

function newSession(title: string): ChatSession {
  return { id: newSessionId(), title, turns: [], updatedAt: Date.now() }
}

function sessionTitle(turns: ChatTurn[], fallbackTitle: string): string {
  const first = turns.find((t) => t.role === 'user' && !t.error)
  if (!first) return fallbackTitle
  const t = first.content.trim()
  return t.length > 22 ? `${t.slice(0, 22)}…` : t || fallbackTitle
}

/** Убирает JSON-обёртку от модели (в т.ч. битый JSON с кавычками внутри answer). */
function extractAnswerText(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
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
  return text
}

const EMPTY_ANSWER_MARKERS = new Set([
  '(пустой ответ)',
])

function assistantDisplayText(t: ChatTurn): string {
  if (t.role !== 'assistant' || t.error) return t.content
  const fromParsed = t.parsed?.answer?.trim()
  if (fromParsed && !EMPTY_ANSWER_MARKERS.has(fromParsed) && !fromParsed.startsWith('{')) {
    if (!fromParsed.includes('"answer"')) return fromParsed
  }
  const c = t.content.trim()
  if (!c) return fromParsed || ''
  if (c.startsWith('{') || c.includes('"answer"')) return extractAnswerText(c) || c
  return t.content
}

function answerFromResponse(res: WikiRagChatResponse): string {
  const raw = (res.raw ?? '').trim()
  const parsedAns = res.parsed?.answer?.trim()
  if (
    parsedAns &&
    !EMPTY_ANSWER_MARKERS.has(parsedAns) &&
    !parsedAns.startsWith('{') &&
    !parsedAns.includes('"answer"')
  ) {
    return parsedAns
  }
  if (raw) {
    const fromRaw = extractAnswerText(raw)
    return fromRaw || raw
  }
  return parsedAns || ''
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

function loadSessions(fallbackTitle: string): { sessions: ChatSession[]; activeId: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      const s = newSession(fallbackTitle)
      return { sessions: [s], activeId: s.id }
    }
    const data = JSON.parse(raw) as { sessions?: ChatSession[]; activeId?: string }
    const sessions = (data.sessions ?? [])
      .filter((s) => s?.id)
      .map((s) => ({
        ...s,
        turns: (s.turns ?? []).map((t) => ({ ...t, reveal: false })),
      }))
    if (!sessions.length) {
      const s = newSession(fallbackTitle)
      return { sessions: [s], activeId: s.id }
    }
    const activeId = sessions.some((s) => s.id === data.activeId) ? data.activeId! : sessions[0].id
    return { sessions, activeId }
  } catch {
    const s = newSession(fallbackTitle)
    return { sessions: [s], activeId: s.id }
  }
}

/** Пишем сразу (не ждём useEffect) — иначе F5 до эффекта теряет ответ. */
function saveSessions(sessions: ChatSession[], activeId: string) {
  const payload = {
    sessions: sessions.map((s) => ({
      ...s,
      // reveal только для анимации в текущей сессии вкладки
      turns: s.turns.map((t) => (t.reveal ? { ...t, reveal: false } : t)),
    })),
    activeId,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Quota: оставляем активный чат + ещё 2 свежих
    try {
      const sorted = [...payload.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
      const keepIds = new Set(
        [activeId, ...sorted.map((s) => s.id)].filter(Boolean).slice(0, 3),
      )
      const trimmed = payload.sessions.filter((s) => keepIds.has(s.id))
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions: trimmed, activeId }))
    } catch {
      /* ignore */
    }
  }
}

export function WikiRagChat({
  onClose,
  onOpenDocument,
}: {
  onClose?: () => void
  onOpenDocument?: (id: number) => void
}) {
  const t = useT()
  const fallbackTitle = t('wikirag.chat.newSessionTitle')
  const emptyModelResponse = t('wikirag.chat.emptyModelResponse')
  const initial = loadSessions(fallbackTitle)
  const [sessions, setSessions] = useState<ChatSession[]>(initial.sessions)
  const [activeId, setActiveId] = useState(initial.activeId)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [lmOk, setLmOk] = useState<boolean | null>(null)
  const [lmDetail, setLmDetail] = useState<string | null>(null)
  const [lmModels, setLmModels] = useState<string[]>([])
  const [lmSettings, setLmSettings] = useState<LmSettings>(() => loadLmSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [revealingTurn, setRevealingTurn] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const activeIdRef = useRef(activeId)
  const sessionsRef = useRef(sessions)

  const active = sessions.find((s) => s.id === activeId) ?? sessions[0]
  const turns = active?.turns ?? []

  useEffect(() => {
    activeIdRef.current = activeId
  }, [activeId])

  useEffect(() => {
    sessionsRef.current = sessions
  }, [sessions])

  useEffect(() => {
    saveSessions(sessions, activeId)
  }, [sessions, activeId])

  // На случай закрытия вкладки до следующего React commit
  useEffect(() => {
    const flush = () => saveSessions(sessionsRef.current, activeIdRef.current)
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      window.removeEventListener('beforeunload', flush)
    }
  }, [])

  const updateActive = useCallback((patch: (s: ChatSession) => ChatSession) => {
    setSessions((list) => {
      const next = list.map((s) => {
        if (s.id !== activeIdRef.current) return s
        const patched = patch(s)
        return { ...patched, title: sessionTitle(patched.turns, fallbackTitle), updatedAt: Date.now() }
      })
      saveSessions(next, activeIdRef.current)
      return next
    })
  }, [fallbackTitle])

  useEffect(() => {
    saveLmSettings(lmSettings)
  }, [lmSettings])

  const checkLm = useCallback(async () => {
    try {
      const st = await api.wikiRagLmStudioStatus({
        base_url: lmSettings.baseUrl,
        model: lmSettings.model || undefined,
      })
      setLmOk(st.ok)
      setLmModels(st.models)
      const picked = st.selected_model || (st.models.length === 1 ? st.models[0] : '') || ''
      if ((!lmSettings.model && picked) || (st.models.length === 1 && picked)) {
        setLmSettings((s) => ({ ...s, model: picked }))
      } else if (lmSettings.model && st.models.length && !st.models.includes(lmSettings.model)) {
        const alt = st.models.find(
          (m) => m === lmSettings.model || m.includes(lmSettings.model) || lmSettings.model.includes(m),
        )
        if (alt) setLmSettings((s) => ({ ...s, model: alt }))
      }
      const detail = st.ok
        ? [picked, st.base_url].filter(Boolean).join(' · ')
        : (st.detail ?? t('wikirag.chat.noConnection'))
      setLmDetail(detail)
    } catch {
      setLmOk(false)
      setLmDetail(t('wikirag.chat.checkFailed'))
    }
  }, [lmSettings.baseUrl, lmSettings.model, t])

  useEffect(() => {
    void checkLm()
  }, [checkLm, lmSettings.baseUrl])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, sending, activeId, revealingTurn])

  function addSession() {
    const s = newSession(fallbackTitle)
    setSessions((list) => {
      const next = [...list, s]
      saveSessions(next, s.id)
      return next
    })
    setActiveId(s.id)
    setInput('')
  }

  function clearActive() {
    updateActive((s) => ({ ...s, turns: [], title: fallbackTitle }))
    setInput('')
  }

  function closeSession(id: string) {
    setSessions((list) => {
      if (list.length <= 1) {
        const s = newSession(fallbackTitle)
        setActiveId(s.id)
        saveSessions([s], s.id)
        return [s]
      }
      const next = list.filter((s) => s.id !== id)
      const nextActive = activeIdRef.current === id ? next[0].id : activeIdRef.current
      if (activeIdRef.current === id) setActiveId(next[0].id)
      saveSessions(next, nextActive)
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
      const res = await api.wikiRagChat({
        message: q,
        document_ids: null,
        history,
        lm_base_url: lmSettings.baseUrl,
        lm_model: lmSettings.model || null,
        include_corax: lmSettings.includeCorax,
      })
      if (!res.ok) {
        const msg = res.error ?? t('wikirag.chat.lmError')
        updateActive((s) => ({
          ...s,
          turns: [...s.turns, { role: 'assistant', content: msg, error: true, meta: res.meta }],
        }))
        return
      }
      const parsed = res.parsed
      const text = answerFromResponse(res) || emptyModelResponse
      // Сразу полный текст в storage; reveal только для анимации на экране
      updateActive((s) => {
        const nextTurns: ChatTurn[] = [
          ...s.turns,
          { role: 'assistant', content: text, parsed, meta: res.meta, reveal: true },
        ]
        setRevealingTurn(nextTurns.length - 1)
        return { ...s, turns: nextTurns }
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : t('wikirag.chat.error')
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
      <div className="flex items-start justify-between gap-2 border-b border-[var(--color-border)] pb-2">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{t('wikirag.chat.title')}</h2>
          <p className="mt-0.5 text-[10px] text-[var(--color-fg-subtle)]">{t('wikirag.chat.contextHint')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="rounded-lg border border-[var(--color-border)] px-2 py-0.5 text-[9px] font-semibold text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            title={t('wikirag.chat.settingsTitle')}
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={() => void checkLm()}
            title={lmDetail ?? undefined}
            className={`rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
              lmOk === true
                ? 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-fg)]'
                : lmOk === false
                  ? 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]'
            }`}
          >
            {lmOk === null ? '…' : lmOk ? 'OK' : 'OFF'}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)]"
              aria-label={t('wikirag.chat.collapse')}
            >
              <IconClose className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
      {lmDetail ? (
        <p
          className={`mt-1 truncate text-[10px] ${
            lmOk ? 'text-[var(--color-fg-subtle)]' : 'text-[var(--color-warning-fg)]'
          }`}
        >
          {lmDetail}
        </p>
      ) : null}

      {settingsOpen ? (
        <div className="mt-2 space-y-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2 text-[10px]">
          <label className="block">
            <span className="mb-0.5 block font-semibold text-[var(--color-fg-muted)]">{t('wikirag.chat.lmBaseUrl')}</span>
            <input
              type="text"
              value={lmSettings.baseUrl}
              onChange={(e) => setLmSettings((s) => ({ ...s, model: '', baseUrl: e.target.value }))}
              onBlur={() => void checkLm()}
              placeholder="http://192.168.1.10:1234/v1"
              className="app-input !min-h-0 !rounded !px-2 !py-1 !text-[11px]"
            />
          </label>
          <p className="text-[var(--color-fg-subtle)]">
            {t('wikirag.chat.lmHelp')}
          </p>
          <label className="block">
            <span className="mb-0.5 block font-semibold text-[var(--color-fg-muted)]">{t('wikirag.chat.model')}</span>
            <select
              value={lmSettings.model}
              onChange={(e) => setLmSettings((s) => ({ ...s, model: e.target.value }))}
              className="app-input !min-h-0 !rounded !px-2 !py-1 !text-[11px]"
              disabled={!lmModels.length}
            >
              {!lmModels.length ? (
                <option value="">{t('wikirag.chat.loadModelHint')}</option>
              ) : (
                <>
                  {lmModels.length > 1 && !lmSettings.model ? (
                    <option value="">{t('wikirag.chat.autoModel')}</option>
                  ) : null}
                  {lmModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
          <label className="flex items-center gap-2 text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={lmSettings.includeCorax}
              onChange={(e) => setLmSettings((s) => ({ ...s, includeCorax: e.target.checked }))}
            />
            <span>{t('wikirag.chat.includeCorax')}</span>
          </label>
          <button
            type="button"
            onClick={() => void checkLm()}
            className="rounded border border-[var(--color-border)] px-2 py-1 text-[10px] text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
          >
            {t('wikirag.chat.checkConnection')}
          </button>
        </div>
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
              className={`group flex max-w-[7rem] shrink-0 items-center gap-0.5 rounded-lg border px-2 py-1 text-[10px] font-medium transition ${
                s.id === activeId
                  ? 'border-[color-mix(in_srgb,var(--color-primary)_45%,var(--color-border))] bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                  : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]'
              }`}
              title={s.title}
            >
              <span className="truncate">{s.title}</span>
              {sessions.length > 1 ? (
                <span
                  role="button"
                  tabIndex={0}
                  className="ml-0.5 rounded px-0.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
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
          onClick={addSession}
          className="shrink-0 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs font-bold text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"
          title={t('wikirag.chat.newChat')}
        >
          +
        </button>
      </div>

      <div className="mt-1 flex gap-1">
        <button
          type="button"
          onClick={clearActive}
          disabled={!turns.length}
          className="rounded-md border border-[var(--color-border)] px-2 py-0.5 text-[10px] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] disabled:opacity-40"
        >
          {t('wikirag.chat.clear')}
        </button>
      </div>

      <div
        ref={scrollRef}
        className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2"
      >
        {turns.length === 0 ? (
          <div className="wikirag-msg-enter space-y-2 px-1 py-2">
            <p className="text-xs text-[var(--color-fg-muted)]">
              {t('wikirag.chat.emptyHint')}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                t('wikirag.chat.sample1'),
                t('wikirag.chat.sample2'),
                t('wikirag.chat.sample3'),
              ].map((hint) => (
                <button
                  key={hint}
                  type="button"
                  className="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-fg-muted)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
                  onClick={() => setInput(hint)}
                >
                  {hint}
                </button>
              ))}
            </div>
          </div>
        ) : (
          turns.map((turn, i) => {
            const display = turn.role === 'assistant' ? assistantDisplayText(turn) : turn.content
            const isRevealing = turn.role === 'assistant' && !turn.error && revealingTurn === i && Boolean(turn.reveal)
            return (
            <div
              key={`${activeId}-${i}-${turn.role}`}
              className={`wikirag-msg-enter rounded-lg px-2.5 py-2 text-xs ${
                turn.role === 'user'
                  ? 'ml-3 border border-[color-mix(in_srgb,var(--color-primary)_35%,var(--color-border))] bg-[var(--color-primary-muted)] text-[var(--color-fg)]'
                  : turn.error
                    ? 'mr-1 border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-fg)]'
                    : 'mr-1 border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
              }`}
              style={{ animationDelay: `${Math.min(i, 6) * 40}ms` }}
            >
              <p className="mb-0.5 text-[9px] font-bold uppercase text-[var(--color-fg-subtle)]">
                {turn.role === 'user' ? t('wikirag.chat.you') : turn.error ? t('wikirag.chat.error') : t('wikirag.chat.ai')}
                {turn.meta?.mode ? ` · ${turn.meta.mode}` : ''}
                {turn.meta?.corax?.computers ? ` · ${turn.meta.corax.computers} PC` : ''}
              </p>
              {isRevealing ? (
                <TypewriterText
                  text={display}
                  active
                  onComplete={() => {
                    setRevealingTurn(null)
                    updateActive((s) => ({
                      ...s,
                      turns: s.turns.map((tr, j) =>
                        j === i ? { ...tr, reveal: false } : tr,
                      ),
                    }))
                  }}
                />
              ) : (
                <p className="whitespace-pre-wrap leading-relaxed">{display}</p>
              )}
              {turn.parsed?.sources?.length ? (
                <ul className="mt-1.5 space-y-0.5 border-t border-[var(--color-border)] pt-1.5">
                  {turn.parsed.sources.map((s, j) => (
                    <li key={j}>
                      <button
                        type="button"
                        className="text-left text-[var(--color-primary)] underline"
                        onClick={() => onOpenDocument?.(s.document_id)}
                      >
                        {s.filename}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )})
        )}
        {sending ? <ThinkingBubble /> : null}
      </div>

      <div className="mt-2 flex gap-1.5">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          placeholder={t('wikirag.chat.promptPlaceholder')}
          className="app-input min-h-[2.5rem] flex-1 !rounded-lg !px-2 !py-1.5 !text-xs"
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
          className="shrink-0 self-end app-btn app-btn-primary !min-h-[36px] !px-3 !py-2 !text-xs"
        >
          →
        </button>
      </div>
    </div>
  )
}
