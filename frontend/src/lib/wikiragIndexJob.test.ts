import { beforeEach, describe, expect, it } from 'vitest'
import {
  getWikiRagIndexJob,
  startWikiRagIndexJob,
  syncWikiRagIndexJobFromDocs,
  syncWikiRagIndexJobFromStatus,
} from './wikiragIndexJob'

describe('wikiragIndexJob', () => {
  beforeEach(() => {
    sessionStorage.clear()
    syncWikiRagIndexJobFromDocs([])
  })

  it('does not auto-start when docs are merely pending', () => {
    const snap = syncWikiRagIndexJobFromDocs([
      { id: 1, index_status: 'pending' },
      { id: 2, index_status: 'pending' },
    ])
    expect(snap.active).toBe(false)
    expect(snap.pending).toBe(2)
    expect(getWikiRagIndexJob().active).toBe(false)
  })

  it('full reindex stays active until all pending clear', () => {
    startWikiRagIndexJob(2)
    expect(getWikiRagIndexJob().active).toBe(true)

    let snap = syncWikiRagIndexJobFromDocs([
      { id: 1, index_status: 'pending' },
      { id: 2, index_status: 'ready' },
    ])
    expect(snap.active).toBe(true)
    expect(snap.pending).toBe(1)

    snap = syncWikiRagIndexJobFromDocs([
      { id: 1, index_status: 'ready' },
      { id: 2, index_status: 'ready' },
    ])
    expect(snap.active).toBe(false)
    expect(snap.justFinished).toBe(true)
  })

  it('single-doc reindex ignores other pending files', () => {
    startWikiRagIndexJob(1, [7])
    let snap = syncWikiRagIndexJobFromDocs([
      { id: 7, index_status: 'pending' },
      { id: 8, index_status: 'pending' },
      { id: 9, index_status: 'pending' },
    ])
    expect(snap.active).toBe(true)

    snap = syncWikiRagIndexJobFromDocs([
      { id: 7, index_status: 'ready' },
      { id: 8, index_status: 'pending' },
      { id: 9, index_status: 'pending' },
    ])
    expect(snap.active).toBe(false)
    expect(snap.justFinished).toBe(true)
    expect(snap.pending).toBe(2)
  })

  it('does not inflate baseline to full library size', () => {
    startWikiRagIndexJob(1, [7])
    const snap = syncWikiRagIndexJobFromDocs([
      { id: 7, index_status: 'pending' },
      ...Array.from({ length: 50 }, (_, i) => ({ id: 100 + i, index_status: 'ready' as const })),
    ])
    expect(snap.active).toBe(true)
    expect(snap.baseline).toBe(1)
    expect(snap.pending).toBe(1)
  })

  it('status endpoint sync finishes tracked ids without the full library', () => {
    startWikiRagIndexJob(1, [7])
    const snap = syncWikiRagIndexJobFromStatus({
      pending: 40,
      ready: 10,
      error: 0,
      total: 50,
      indexing: true,
      pending_ids: [8, 9],
      active_id: 8,
    })
    expect(snap.active).toBe(false)
    expect(snap.justFinished).toBe(true)
    expect(snap.pending).toBe(40)
  })
})
