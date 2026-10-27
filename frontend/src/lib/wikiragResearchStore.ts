import { streamWikiRagResearch, type WikiRagChatParsed, type WikiRagChatResponse, type WikiRagProgress } from '../api'
import { measuredTokenRate, settledTokenRate } from './wikiragTokenRate'
import { loadWikiRagLmSettings } from './wikiragLmSettings'
import { randomId } from './randomId'

export const WIKIRAG_RESEARCH_CHATS_KEY = 'inventory-wikirag-research-chats-v1'
const LEGACY_TURNS_KEY = 'inventory-wikirag-research-v1'
const CHANGE_EVENT = 'wikirag-research-chats'

export type WikiRagResearchTurn = {
  role: 'user' | 'assistant'
  content: string
  parsed?: WikiRagChatParsed | null
  error?: boolean
  meta?: WikiRagChatResponse['meta']
  progress?: WikiRagProgress | null
  opened?: string[]
  queries?: string[]
  streamTokens?: number
  streamChars?: number
  streamStartedAt?: number
  tokensPerSecond?: number
}

export type WikiRagResearchSession = {
  id: string
  title: string
  turns: WikiRagResearchTurn[]
  updatedAt: number
}

export type WikiRagResearchState = {
  sessions: WikiRagResearchSession[]
  activeId: string
}

const pending = new Map<string, Promise<void>>()
let live: WikiRagResearchState | null = null
let liveRaw: string | null = null
let liveDirty = false
let flushTimer = 0

function newSessionId(): string {
  return randomId()
}

export function newWikiRagResearchSession(title: string): WikiRagResearchSession {
  return { id: newSessionId(), title, turns: [], updatedAt: Date.now() }
}

export function wikiRagResearchTitle(turns: WikiRagResearchTurn[], fallbackTitle: string): string {
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

function readLegacyTurns(): WikiRagResearchTurn[] {
  try {
    const raw = localStorage.getItem(LEGACY_TURNS_KEY)
    if (!raw) return []
    const data = JSON.parse(raw) as { turns?: WikiRagResearchTurn[] }
    return Array.isArray(data.turns) ? data.turns : []
  } catch {
    return []
  }
}

export function loadWikiRagResearchChats(fallbackTitle: string): WikiRagResearchState {
  if (live && liveDirty) return live
  let raw: string | null = null
  try {
    raw = localStorage.getItem(WIKIRAG_RESEARCH_CHATS_KEY)
  } catch {
    raw = null
  }
  if (live && raw === liveRaw) return live
  live = readWikiRagResearchChats(fallbackTitle)
  liveRaw = raw
  return live
}

function readWikiRagResearchChats(fallbackTitle: string): WikiRagResearchState {
  try {
    const raw = localStorage.getItem(WIKIRAG_RESEARCH_CHATS_KEY)
    if (!raw) {
      const legacy = readLegacyTurns()
      const s = newWikiRagResearchSession(fallbackTitle)
      if (legacy.length) {
        s.turns = legacy
        s.title = wikiRagResearchTitle(legacy, fallbackTitle)
      }
      return { sessions: [s], activeId: s.id }
    }
    const data = JSON.parse(raw) as { sessions?: WikiRagResearchSession[]; activeId?: string }
    const sessions = (data.sessions ?? []).filter((s) => s?.id)
    if (!sessions.length) {
      const s = newWikiRagResearchSession(fallbackTitle)
      return { sessions: [s], activeId: s.id }
    }
    const activeId = sessions.some((s) => s.id === data.activeId) ? data.activeId! : sessions[0].id
    return { sessions, activeId }
  } catch {
    const s = newWikiRagResearchSession(fallbackTitle)
    return { sessions: [s], activeId: s.id }
  }
}

export function saveWikiRagResearchChats(sessions: WikiRagResearchSession[], activeId: string): boolean {
  live = { sessions, activeId }
  liveDirty = false
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = 0
  }
  const payload = { sessions, activeId }
  const next = JSON.stringify(payload)
  try {
    if (localStorage.getItem(WIKIRAG_RESEARCH_CHATS_KEY) === next) {
      liveRaw = next
      return false
    }
  } catch {
    /* continue */
  }
  try {
    localStorage.setItem(WIKIRAG_RESEARCH_CHATS_KEY, next)
    liveRaw = next
    localStorage.removeItem(LEGACY_TURNS_KEY)
  } catch {
    try {
      const sorted = [...payload.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
      const keepIds = new Set([activeId, ...sorted.map((s) => s.id)].filter(Boolean).slice(0, 3))
      const trimmed = payload.sessions.filter((s) => keepIds.has(s.id))
      const trimmedRaw = JSON.stringify({ sessions: trimmed, activeId })
      localStorage.setItem(WIKIRAG_RESEARCH_CHATS_KEY, trimmedRaw)
      liveRaw = trimmedRaw
    } catch {
      return false
    }
  }
  emitChange()
  return true
}

export function subscribeWikiRagResearchChats(onChange: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === WIKIRAG_RESEARCH_CHATS_KEY || e.key === LEGACY_TURNS_KEY || e.key === null) {
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

export function isWikiRagResearchPending(sessionId: string): boolean {
  return pending.has(sessionId)
}

function historyForLm(turns: WikiRagResearchTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  let pendingUser: { role: 'user'; content: string } | null = null
  for (const t of turns) {
    if (!t.content.trim() || t.error) continue
    if (t.role === 'user') {
      pendingUser = { role: 'user', content: t.content }
      continue
    }
    if (pendingUser) {
      out.push(pendingUser, { role: 'assistant', content: t.content })
      pendingUser = null
    }
  }
  return out.slice(-6)
}

function flushLiveResearch() {
  if (flushTimer) {
    window.clearTimeout(flushTimer)
    flushTimer = 0
  }
  if (!liveDirty || !live) return
  const snapshot = live
  liveDirty = false
  saveWikiRagResearchChats(snapshot.sessions, snapshot.activeId)
}

function patchSession(
  fallbackTitle: string,
  sessionId: string,
  patch: (s: WikiRagResearchSession) => WikiRagResearchSession,
) {
  const state = loadWikiRagResearchChats(fallbackTitle)
  const sessions = state.sessions.map((s) => {
    if (s.id !== sessionId) return s
    const next = patch(s)
    return {
      ...next,
      title: wikiRagResearchTitle(next.turns, fallbackTitle),
      updatedAt: Date.now(),
    }
  })
  live = { sessions, activeId: state.activeId }
  liveDirty = true
  emitChange()
  if (!flushTimer) {
    flushTimer = window.setTimeout(() => {
      flushTimer = 0
      flushLiveResearch()
    }, 400)
  }
}

function answerFromResponse(res: WikiRagChatResponse, streamedFallback = ''): string {
  const parsedAns = (res.parsed?.answer || '').trim()
  if (parsedAns && !parsedAns.startsWith('{') && !parsedAns.includes('"answer"')) {
    const streamed = streamedFallback.trim()
    if (streamed.length > Math.max(120, parsedAns.length * 2)) return streamed
    return parsedAns
  }
  return streamedFallback.trim() || parsedAns || ''
}

export function sendWikiRagResearchMessage(opts: {
  sessionId: string
  message: string
  fallbackTitle: string
  emptyModelResponse: string
  errorFallback: string
}): boolean {
  const { sessionId, message, fallbackTitle, emptyModelResponse, errorFallback } = opts
  const q = message.trim()
  if (!q || pending.has(sessionId)) return false

  const before = loadWikiRagResearchChats(fallbackTitle)
  const session = before.sessions.find((s) => s.id === sessionId)
  if (!session) return false

  const history = historyForLm(session.turns)
  patchSession(fallbackTitle, sessionId, (s) => ({
    ...s,
    turns: [
      ...s.turns,
      { role: 'user', content: q },
      { role: 'assistant', content: '', progress: { stage: 'search', label: '' } },
    ],
  }))

  const lm = loadWikiRagLmSettings()
  const job = (async () => {
    try {
      let receivedDone = false
      await streamWikiRagResearch(
        {
          message: q,
          history,
          lm_base_url: lm.baseUrl,
          lm_model: lm.model || null,
        },
        {
          onProgress: (progress) => {
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns[turns.length - 1]
              if (!last || last.role !== 'assistant') return s
              const opened = [...(last.opened || [])]
              const queries = [...(last.queries || [])]
              for (const item of progress.queries || []) {
                const q = item.trim()
                if (q && !queries.includes(q)) queries.push(q)
              }
              if (progress.query?.trim() && !queries.includes(progress.query.trim())) {
                queries.push(progress.query.trim())
              }
              const title = (progress.title || '').trim()
              if (progress.stage === 'open' && title && !opened.includes(title)) opened.push(title)
              if (progress.titles?.length) {
                for (const item of progress.titles) {
                  if (item && !opened.includes(item)) opened.push(item)
                }
              }
              const sources = [...(last.parsed?.sources || [])]
              const href = (progress.url || '').trim()
              if (href.startsWith('http') && !sources.some((row) => row.filename === href)) {
                sources.push({
                  document_id: 0,
                  filename: href,
                  excerpt: '',
                  label: title || href,
                  kind: 'web',
                })
              }
              turns[turns.length - 1] = {
                ...last,
                progress,
                opened,
                queries,
                parsed: sources.length ? { ...(last.parsed || {}), sources } : last.parsed,
              }
              return { ...s, turns }
            })
          },
          onMeta: (meta) => {
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns[turns.length - 1]
              if (!last || last.role !== 'assistant') return s
              turns[turns.length - 1] = { ...last, meta: { ...last.meta, ...meta } }
              return { ...s, turns }
            })
          },
          onDelta: (text) => {
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns[turns.length - 1]
              if (!last || last.role !== 'assistant') return s
              turns[turns.length - 1] = {
                ...last,
                content: last.content + text,
                progress: last.progress ? { ...last.progress, stage: 'generate' } : last.progress,
                streamTokens: (last.streamTokens ?? 0) + 1,
                streamChars: (last.streamChars ?? 0) + text.length,
                streamStartedAt: last.streamStartedAt ?? Date.now(),
              }
              return { ...s, turns }
            })
          },
          onDone: (res) => {
            receivedDone = true
            patchSession(fallbackTitle, sessionId, (s) => {
              const turns = [...s.turns]
              const last = turns[turns.length - 1]
              if (!last || last.role !== 'assistant') return s
              const streamed = last.content || ''
              const text = answerFromResponse(res, streamed) || emptyModelResponse
              const metaSources = Array.isArray(res.meta?.sources) ? res.meta.sources : []
              const parsedSources = res.parsed?.sources ?? []
              const sources = parsedSources.length ? parsedSources : (metaSources as typeof parsedSources)
              const parsed = res.parsed
                ? { ...res.parsed, sources: sources.length ? sources : res.parsed.sources }
                : sources.length
                  ? { answer: text, sources }
                  : res.parsed
              turns[turns.length - 1] = {
                ...last,
                content: text,
                parsed,
                meta: res.meta,
                progress: null,
                queries: last.queries,
                streamTokens: undefined,
                streamChars: undefined,
                streamStartedAt: undefined,
                tokensPerSecond: settledTokenRate(
                  res.meta,
                  measuredTokenRate(last.streamTokens, last.streamStartedAt, Date.now(), last.streamChars),
                ),
              }
              return { ...s, turns }
            })
          },
        },
      )
      if (!receivedDone) {
        patchSession(fallbackTitle, sessionId, (s) => ({
          ...s,
          turns: [...s.turns.slice(0, -1), { role: 'assistant', content: errorFallback, error: true }],
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
      flushLiveResearch()
      emitChange()
    }
  })()

  pending.set(sessionId, job)
  emitChange()
  return true
}
