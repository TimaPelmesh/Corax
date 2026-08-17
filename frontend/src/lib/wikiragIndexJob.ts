/** Background WikiRAG index job — survives page navigation. */

export type WikiRagIndexJobSnapshot = {
  active: boolean
  baseline: number
  pending: number
  ready: number
  error: number
  total: number
  /** When set, job tracks only these document ids (single-file reindex). */
  trackIds: number[] | null
  /** Set when a run finishes so UI can toast once. */
  justFinished: boolean
}

type Listener = () => void

const KEY = 'corax.wikirag.indexJob.v3'

let state: WikiRagIndexJobSnapshot = {
  active: false,
  baseline: 0,
  pending: 0,
  ready: 0,
  error: 0,
  total: 0,
  trackIds: null,
  justFinished: false,
}

const listeners = new Set<Listener>()

function emit() {
  for (const fn of listeners) fn()
}

function persistActive() {
  try {
    if (state.active) {
      sessionStorage.setItem(
        KEY,
        JSON.stringify({
          active: true,
          baseline: state.baseline,
          trackIds: state.trackIds,
          startedAt: Date.now(),
        }),
      )
    } else {
      sessionStorage.removeItem(KEY)
    }
  } catch {
    /* ignore */
  }
}

function restore() {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return
    const data = JSON.parse(raw) as {
      active?: boolean
      baseline?: number
      trackIds?: number[] | null
      startedAt?: number
    }
    if (!data.active) return
    // Drop stale jobs older than 6h
    if (data.startedAt && Date.now() - data.startedAt > 6 * 60 * 60 * 1000) {
      sessionStorage.removeItem(KEY)
      return
    }
    state = {
      ...state,
      active: true,
      baseline: Math.max(1, Number(data.baseline) || 1),
      trackIds: Array.isArray(data.trackIds) ? data.trackIds.map(Number) : null,
    }
  } catch {
    /* ignore */
  }
}

restore()

export function getWikiRagIndexJob(): WikiRagIndexJobSnapshot {
  return state
}

export function subscribeWikiRagIndexJob(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Start tracking: omit trackIds for full reindex; pass ids for one/few docs. */
export function startWikiRagIndexJob(baseline = 1, trackIds?: number[] | null): void {
  state = {
    ...state,
    active: true,
    baseline: Math.max(1, baseline),
    trackIds: trackIds?.length ? [...trackIds] : null,
    justFinished: false,
  }
  persistActive()
  emit()
}

export function clearWikiRagIndexJobFinishedFlag(): void {
  if (!state.justFinished) return
  state = { ...state, justFinished: false }
  emit()
}

/**
 * Sync counters from document list.
 * Completes an explicit job when tracked docs leave pending — does NOT auto-start
 * just because other files are pending (e.g. CORAX import).
 */
export function syncWikiRagIndexJobFromDocs(
  docs: { id?: number; index_status?: string | null }[],
): WikiRagIndexJobSnapshot {
  const pendingIds: number[] = []
  let pending = 0
  let ready = 0
  let error = 0
  for (const d of docs) {
    const s = (d.index_status || 'pending').toLowerCase()
    if (s === 'ready') ready += 1
    else if (s === 'error') error += 1
    else {
      pending += 1
      if (d.id != null) pendingIds.push(d.id)
    }
  }
  return syncWikiRagIndexJobFromStatus({
    pending,
    ready,
    error,
    total: docs.length,
    queue_size: pending,
    active_id: null,
    indexing: pending > 0,
    pending_ids: pendingIds,
  })
}

/**
 * Sync counters from GET /wiki-rag/index-status (no full document list).
 */
export function syncWikiRagIndexJobFromStatus(st: {
  pending: number
  ready: number
  error: number
  total: number
  queue_size?: number
  active_id?: number | null
  indexing?: boolean
  pending_ids?: number[]
}): WikiRagIndexJobSnapshot {
  const pending = st.pending
  const ready = st.ready
  const error = st.error
  const total = st.total
  const pendingIds = st.pending_ids ?? []

  const wasActive = state.active
  let stillPending = false
  if (wasActive) {
    if (state.trackIds?.length) {
      const idSet = new Set(state.trackIds)
      stillPending =
        pendingIds.some((id) => idSet.has(id)) ||
        (st.active_id != null && idSet.has(st.active_id))
    } else {
      stillPending = pending > 0 || Boolean(st.indexing)
    }
  }

  const justFinished = state.justFinished || (wasActive && !stillPending)

  state = {
    active: wasActive && stillPending,
    baseline: Math.max(state.baseline || 0, state.trackIds?.length || 0, 1),
    pending,
    ready,
    error,
    total,
    trackIds: wasActive && stillPending ? state.trackIds : null,
    justFinished,
  }
  persistActive()
  emit()
  return state
}
