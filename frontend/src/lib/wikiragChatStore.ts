import { streamWikiRagChat, type WikiRagChatParsed, type WikiRagChatResponse } from '../api'
import { measuredTokenRate, settledTokenRate } from './wikiragTokenRate'
import { loadWikiRagLmSettings } from './wikiragLmSettings'
import { randomId } from './randomId'

export const WIKIRAG_CHATS_KEY = 'inventory-wikirag-chats-v1'
const CHANGE_EVENT = 'wikirag-chats'

export type WikiRagChatTurn = {
  role: 'user' | 'assistant'
  content: string
  parsed?: WikiRagChatParsed | null
  error?: boolean
  meta?: WikiRagChatResponse['meta']
  reveal?: boolean
  /** Ollama chunks and characters seen during this answer. Dropped once the reply settles. */
  streamTokens?: number
  streamChars?: number
  streamStartedAt?: number
  tokensPerSecond?: number
}

export type WikiRagChatSession = {
  id: string
  title: string
  turns: WikiRagChatTurn[]
  updatedAt: number
}

export type WikiRagChatsState = {
  sessions: WikiRagChatSession[]
  activeId: string
}

/** In-flight requests survive SPA navigation (module scope). Lost only on full page reload. */
const pending = new Map<string, Promise<void>>()
/** Live chats. Token updates paint from here; localStorage is flushed off the token path. */
let live: WikiRagChatsState | null = null
let liveRaw: string | null = null
let liveDirty = false
let flushTimer = 0

function newSessionId(): string {
  return randomId()
}

export function newWikiRagSession(title: string): WikiRagChatSession {
  return { id: newSessionId(), title, turns: [], updatedAt: Date.now() }
}

export function wikiRagSessionTitle(turns: WikiRagChatTurn[], fallbackTitle: string): string {
  const first = turns.find((t) => t.role === 'user' && !t.error)
  if (!first) return fallbackTitle
  const t = first.content.trim()
  return t.length > 22 ? `${t.slice(0, 22)}…` : t || fallbackTitle
}

function emitChange() {
  try {
    window.dispatchEvent(new Event(CHANGE_EVENT))
  } catch {
    /* ignore */
  }
}

export function loadWikiRagChats(fallbackTitle: string): WikiRagChatsState {
  if (live && liveDirty) return live
  let raw: string | null = null
  try {
    raw = localStorage.getItem(WIKIRAG_CHATS_KEY)
  } catch {
    raw = null
  }
  if (live && raw === liveRaw) return live
  live = readWikiRagChats(fallbackTitle)
  liveRaw = raw
  return live
}

function readWikiRagChats(fallbackTitle: string): WikiRagChatsState {
  try {
    const raw = localStorage.getItem(WIKIRAG_CHATS_KEY)
    if (!raw) {
      const s = newWikiRagSession(fallbackTitle)
      return { sessions: [s], activeId: s.id }
    }
    const data = JSON.parse(raw) as { sessions?: WikiRagChatSession[]; activeId?: string }
    const sessions = (data.sessions ?? [])
      .filter((s) => s?.id)
      .map((s) => ({
        ...s,
        turns: (s.turns ?? []).map((t) => ({ ...t, reveal: false })),
      }))
    if (!sessions.length) {
      const s = newWikiRagSession(fallbackTitle)
      return { sessions: [s], activeId: s.id }
    }
    const activeId = sessions.some((s) => s.id === data.activeId) ? data.activeId! : sessions[0].id
    return { sessions, activeId }
  } catch {
    const s = newWikiRagSession(fallbackTitle)
    return { sessions: [s], activeId: s.id }
  }
}

export function saveWikiRagChats(sessions: WikiRagChatSession[], activeId: string): boolean {
  live = { sessions, activeId }
  liveDirty = false
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = 0
  }
  const payload = {
    sessions: sessions.map((s) => ({
      ...s,
      turns: s.turns.map((t) => (t.reveal ? { ...t, reveal: false } : t)),
    })),
    activeId,
  }
  const next = JSON.stringify(payload)
  try {
    if (localStorage.getItem(WIKIRAG_CHATS_KEY) === next) {
      liveRaw = next
      return false
    }
  } catch {
    /* continue */
  }
  try {
    localStorage.setItem(WIKIRAG_CHATS_KEY, next)
    liveRaw = next
  } catch {
    try {
      const sorted = [...payload.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
      const keepIds = new Set([activeId, ...sorted.map((s) => s.id)].filter(Boolean).slice(0, 3))
      const trimmed = payload.sessions.filter((s) => keepIds.has(s.id))
      const trimmedRaw = JSON.stringify({ sessions: trimmed, activeId })
      localStorage.setItem(WIKIRAG_CHATS_KEY, trimmedRaw)
      liveRaw = trimmedRaw
    } catch {
      return false
    }
  }
  emitChange()
  return true
}

export function subscribeWikiRagChats(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === WIKIRAG_CHATS_KEY || e.key === null) {
      live = null
      liveRaw = null
      liveDirty = false
      onChange()
    }
  }
  const onLocal = () => onChange()
  window.addEventListener('storage', onStorage)
  window.addEventListener(CHANGE_EVENT, onLocal)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener(CHANGE_EVENT, onLocal)
  }
}

export function isWikiRagChatPending(sessionId: string): boolean {
  return pending.has(sessionId)
}

export function hasAnyWikiRagChatPending(): boolean {
  return pending.size > 0
}

const EMPTY_ANSWER_MARKERS = new Set(['(пустой ответ)'])

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
    // Жадный захват: нережадный .+? обрезал ответ на первой кавычке / коротком фрагменте.
    const m = text.match(
      /"answer"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"(?:confidence|sources|follow_up|suggested_actions)"/s,
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

function answerFromResponse(res: WikiRagChatResponse, streamedFallback = ''): string {
  const raw = (res.raw ?? '').trim()
  const parsedAns = res.parsed?.answer?.trim()
  // Детерминированный CORAX / fallback всегда важнее обрезанного стрима.
  if (parsedAns && (res.parsed as { _corax_fallback?: boolean; _fast_corax?: boolean } | null)?._corax_fallback) {
    return parsedAns
  }
  if (parsedAns && (res.parsed as { _fast_corax?: boolean } | null)?._fast_corax) {
    return parsedAns
  }
  if (
    parsedAns &&
    !EMPTY_ANSWER_MARKERS.has(parsedAns) &&
    !parsedAns.startsWith('{') &&
    !parsedAns.includes('"answer"')
  ) {
    const streamed = streamedFallback.trim()
    // Если стрим — короткий мусор, а parsed нормальный — берём parsed.
    if (streamed && streamed.length < 80 && parsedAns.length > streamed.length * 2) {
      return parsedAns
    }
    if (streamed.length > Math.max(120, parsedAns.length * 2)) {
      return streamed
    }
    return parsedAns
  }
  if (raw) {
    const fromRaw = extractAnswerText(raw)
    const candidate = fromRaw || raw
    if (streamedFallback.trim().length > Math.max(80, candidate.length * 2)) {
      return streamedFallback.trim()
    }
    return candidate
  }
  return streamedFallback.trim() || parsedAns || ''
}

function historyForLm(turns: WikiRagChatTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  let pendingUser: { role: 'user'; content: string } | null = null
  for (const t of turns) {
    if (!t.content.trim() || t.error) continue
    if (t.role === 'user') {
      pendingUser = { role: 'user', content: t.content }
      continue
    }
    if (pendingUser) {
      const content =
        t.parsed?.answer?.trim() && !EMPTY_ANSWER_MARKERS.has(t.parsed.answer.trim())
          ? t.parsed.answer.trim()
          : t.content
      out.push(pendingUser, { role: 'assistant', content })
      pendingUser = null
    }
  }
  // Новый чат (turns=[]) → history=[]; в том же чате — только последняя пара.
  return out.slice(-2)
}

function flushLiveChats() {
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = 0
  }
  if (!liveDirty || !live) return
  const snapshot = live
  liveDirty = false
  saveWikiRagChats(snapshot.sessions, snapshot.activeId)
}

function patchSession(
  fallbackTitle: string,
  sessionId: string,
  patch: (s: WikiRagChatSession) => WikiRagChatSession,
) {
  const state = loadWikiRagChats(fallbackTitle)
  const sessions = state.sessions.map((s) => {
    if (s.id !== sessionId) return s
    const next = patch(s)
    return {
      ...next,
      title: wikiRagSessionTitle(next.turns, fallbackTitle),
      updatedAt: Date.now(),
    }
  })
  live = { sessions, activeId: state.activeId }
  liveDirty = true
  emitChange()
  if (!flushTimer) {
    flushTimer = window.setTimeout(() => {
      flushTimer = 0
      flushLiveChats()
    }, 400)
  }
}

/**
 * Sends a chat message. Continues even if the WikiRAG page unmounts —
 * result is written to localStorage and UI rehydrates on return.
 * No DB: browser-local only (enough for this stage).
 */
export function sendWikiRagChatMessage(opts: {
  sessionId: string
  message: string
  fallbackTitle: string
  emptyModelResponse: string
  errorFallback: string
}): boolean {
  const { sessionId, message, fallbackTitle, emptyModelResponse, errorFallback } = opts
  const q = message.trim()
  if (!q || pending.has(sessionId)) return false

  const before = loadWikiRagChats(fallbackTitle)
  const session = before.sessions.find((s) => s.id === sessionId)
  if (!session) return false

  const history = historyForLm(session.turns)
  patchSession(fallbackTitle, sessionId, (s) => ({
    ...s,
    turns: [...s.turns, { role: 'user', content: q }, { role: 'assistant', content: '' }],
  }))

  const lm = loadWikiRagLmSettings()
  const job = (async () => {
    try {
      let receivedDone = false
      await streamWikiRagChat(
        {
          message: q,
          document_ids: null,
          history,
          lm_base_url: lm.baseUrl,
          lm_model: lm.model || null,
          include_corax: lm.includeCorax,
          response_mode: lm.responseMode,
        },
        {
          onMeta: (meta) => {
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns.length - 1
              const current = turns[last]
              if (!current || current.role !== 'assistant') return s
              turns[last] = { ...current, meta: { ...current.meta, ...meta } }
              return { ...s, turns }
            })
          },
          onDelta: (text) => {
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns.length - 1
              const current = turns[last]
              if (!current || current.role !== 'assistant') return s
              turns[last] = {
                ...current,
                content: current.content + text,
                streamTokens: (current.streamTokens ?? 0) + 1,
                streamChars: (current.streamChars ?? 0) + text.length,
                streamStartedAt: current.streamStartedAt ?? Date.now(),
              }
              return { ...s, turns }
            })
          },
          onDone: (res) => {
            receivedDone = true
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns.length - 1
              const current = turns[last]
              if (!current || current.role !== 'assistant') return s
              const streamed = current.content || ''
              const text = answerFromResponse(res, streamed) || emptyModelResponse
              const metaSources = Array.isArray(res.meta?.sources) ? res.meta.sources : []
              const parsedSources = res.parsed?.sources ?? []
              const sources = parsedSources.length ? parsedSources : (metaSources as typeof parsedSources)
              const parsed = res.parsed
                ? { ...res.parsed, sources: sources.length ? sources : res.parsed.sources }
                : sources.length
                  ? { answer: text, sources }
                  : res.parsed
              const tokensPerSecond = settledTokenRate(
                res.meta,
                measuredTokenRate(current.streamTokens, current.streamStartedAt, Date.now(), current.streamChars),
              )
              turns[last] = {
                ...current,
                content: text,
                parsed,
                meta: res.meta,
                reveal: false,
                streamTokens: undefined,
                streamChars: undefined,
                streamStartedAt: undefined,
                tokensPerSecond,
              }
              return { ...s, turns }
            })
          },
        },
      )
      if (!receivedDone) {
        const msg = errorFallback
        patchSession(fallbackTitle, sessionId, (s) => ({
          ...s,
          turns: [
            ...s.turns.slice(0, -1),
            { role: 'assistant', content: msg, error: true },
          ],
        }))
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : errorFallback
      patchSession(fallbackTitle, sessionId, (s) => ({
        ...s,
        turns: [...s.turns.slice(0, -1), { role: 'assistant', content: msg, error: true }],
      }))
    } finally {
      pending.delete(sessionId)
      flushLiveChats()
      emitChange()
    }
  })()

  pending.set(sessionId, job)
  emitChange()
  return true
}
