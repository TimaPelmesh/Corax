/** Shared HTTP client: CSRF, timeouts, safe retries, sanitized errors. */

export const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
export const API_PREFIX = '/api/v1'

export const REQUEST_TIMEOUT_MS = 25_000
/** WikiRAG: backend waits for LM Studio / Ollama up to lm_studio_timeout_seconds (default 300s). */
export const WIKIRAG_LM_TIMEOUT_MS = 330_000
export const WIKIRAG_IMPORT_TIMEOUT_MS = 120_000

const IDEMPOTENT = new Set(['GET', 'HEAD'])
const RETRY_STATUSES = new Set([502, 503, 504])
const MAX_GET_ATTEMPTS = 3

export type RequestOptions = RequestInit & { json?: unknown; timeout_ms?: number }

/** Same base URL as `request()` — empty VITE_API_URL means same-origin `/api/v1/...`. */
export function apiUrl(path: string): string {
  return API_BASE ? `${API_BASE}${path}` : path
}

export function requestTimeoutMessage(path: string): string {
  if (
    path.includes('/wiki-rag/chat') ||
    path.includes('/risks/ai-insights') ||
    path.includes('/service-requests/ai-insights')
  ) {
    return (
      'Модель не ответила вовремя (лимит ~5 мин). Проверьте LM Studio / Ollama: модель загружена, ' +
      'таймаут увеличен; для лёгких моделей ответ обычно 30–90 с.'
    )
  }
  if (path.includes('/wiki-rag/import/corax')) {
    return 'Импорт CORAX занял слишком много времени. Проверьте, что API запущен, и повторите.'
  }
  return (
    'Нет ответа от сервера (таймаут). Проверьте, что API запущен ' +
    '(Docker: npm run docker:up / docker compose ps) и порт совпадает (обычно :3000).'
  )
}

export function getCookie(name: string): string | null {
  try {
    const all = document.cookie ?? ''
    const parts = all.split(';')
    for (const p of parts) {
      const s = p.trim()
      if (!s) continue
      const eq = s.indexOf('=')
      if (eq <= 0) continue
      const k = s.slice(0, eq)
      if (k === name) return decodeURIComponent(s.slice(eq + 1))
    }
  } catch {
    // ignore
  }
  return null
}

export function shouldAttachCsrf(method?: string): boolean {
  const m = (method ?? 'GET').toUpperCase()
  return m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE'
}

function formatApiDetail(detail: unknown): string {
  if (typeof detail === 'string') return sanitizeClientError(detail)
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (!item || typeof item !== 'object' || !('msg' in item)) return null
        const msg = String((item as { msg: unknown }).msg)
        const loc = Array.isArray((item as { loc?: unknown }).loc)
          ? (item as { loc: unknown[] }).loc.filter((part) => part !== 'body' && part !== 'query').join('.')
          : ''
        return loc ? `${loc}: ${msg}` : msg
      })
      .filter((part): part is string => Boolean(part))
    if (parts.length) return sanitizeClientError(parts.join('; '))
  }
  if (detail == null) return ''
  try {
    return sanitizeClientError(JSON.stringify(detail))
  } catch {
    return sanitizeClientError(String(detail))
  }
}

export function sanitizeClientError(message: string): string {
  const low = message.toLowerCase()
  if (
    low.includes('sqlalchemy') ||
    low.includes('asyncpg') ||
    low.includes('psycopg') ||
    low.includes('characternotinrepertoire') ||
    (low.includes('utf8') && low.includes('0x00')) ||
    low.includes('internal server error')
  ) {
    return 'Сервер не смог сохранить данные. Повторите действие.'
  }
  return message
}

class TransientNetworkError extends Error {
  override name = 'TransientNetworkError'
}

function isTransientNetwork(error: unknown): boolean {
  if (error instanceof TransientNetworkError) return true
  const raw = error instanceof Error ? error.message : String(error)
  return (
    raw === 'Failed to fetch' ||
    raw === 'Load failed' ||
    raw === 'NetworkError when attempting to fetch resource.' ||
    raw === 'Network request failed'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function requestOnce<T>(path: string, options: RequestOptions): Promise<T> {
  const { json, timeout_ms, keepalive, ...fetchOpts } = options
  const headers = new Headers(options.headers)
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  if (shouldAttachCsrf(options.method)) {
    const csrf = getCookie('csrf_token')
    if (csrf) headers.set('X-CSRF-Token', csrf)
  }

  const persistAcrossUnload = Boolean(keepalive)
  const ctrl = persistAcrossUnload ? null : new AbortController()
  const timeoutMs = timeout_ms ?? REQUEST_TIMEOUT_MS
  const tid = persistAcrossUnload ? 0 : window.setTimeout(() => ctrl?.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(apiUrl(path), {
      ...fetchOpts,
      credentials: 'include',
      headers,
      keepalive: persistAcrossUnload,
      signal: ctrl?.signal,
      body: json !== undefined ? JSON.stringify(json) : options.body,
    })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(requestTimeoutMessage(path))
    }
    if (isTransientNetwork(e)) {
      throw new TransientNetworkError(
        'Нет связи с сервером. Если только что пересобирали Docker — подождите и обновите страницу (npm run docker:up).',
      )
    }
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    if (tid) window.clearTimeout(tid)
  }
  if (!res.ok) {
    if (RETRY_STATUSES.has(res.status)) {
      const err = new Error(res.statusText || `HTTP ${res.status}`)
      ;(err as Error & { status?: number }).status = res.status
      throw err
    }
    const parsed = await res.json().catch(() => null)
    const err = parsed && typeof parsed === 'object' ? parsed : null
    const detail =
      (err as { detail?: unknown } | null)?.detail ??
      (parsed == null ? await res.text().catch(() => '') : '') ??
      res.statusText
    throw new Error(formatApiDetail(detail) || res.statusText)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const persistAcrossUnload = Boolean(options.keepalive)
  const attempts = persistAcrossUnload || !IDEMPOTENT.has(method) ? 1 : MAX_GET_ATTEMPTS

  let last: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await requestOnce<T>(path, options)
    } catch (e) {
      last = e
      const status = e instanceof Error ? (e as Error & { status?: number }).status : undefined
      const retryable = Boolean(status && RETRY_STATUSES.has(status)) || isTransientNetwork(e)
      if (attempt === attempts || !retryable) throw e
      await sleep(220 * attempt)
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

export async function pingHealth(): Promise<boolean> {
  try {
    const ctrl = new AbortController()
    const tid = window.setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(apiUrl(`${API_PREFIX}/health`), {
      credentials: 'omit',
      signal: ctrl.signal,
    })
    window.clearTimeout(tid)
    return res.ok
  } catch {
    return false
  }
}
