import { describe, expect, it } from 'vitest'
import { emptyMapV2, type MapFileV2 } from '@hobo/content'
import {
  DRAFT_MAX_AGE_MS,
  DraftStore,
  memoryDraftStorage,
  type DraftStorage,
} from './draftStore.js'

/** Deterministic clock + scheduler, so nothing here waits on real time. */
function harness(over: { mapKey?: string; storage?: DraftStorage } = {}) {
  let clock = 1_000_000
  const jobs: { at: number; fn: () => void }[] = []
  const storage = over.storage ?? memoryDraftStorage()
  const store = new DraftStore({
    storage,
    mapKey: over.mapKey ?? 'server-a/map.json',
    debounceMs: 1000,
    now: () => clock,
    schedule: (fn, ms) => {
      const job = { at: clock + ms, fn }
      jobs.push(job)
      return job
    },
    cancel: (h) => {
      const i = jobs.indexOf(h as { at: number; fn: () => void })
      if (i >= 0) jobs.splice(i, 1)
    },
  })
  return {
    store,
    storage,
    /** Advance time, running anything that comes due. */
    async tick(ms: number): Promise<void> {
      clock += ms
      for (const job of jobs.filter((j) => j.at <= clock)) {
        jobs.splice(jobs.indexOf(job), 1)
        job.fn()
      }
      await store.flush()
    },
    async jump(ms: number): Promise<void> {
      clock += ms
    },
    pending: () => jobs.length,
  }
}

const mapWith = (color: string): MapFileV2 =>
  ({
    ...emptyMapV2(),
    statics: [{ id: 's1', shape: { type: 'box', size: [1, 1, 1] }, pos: [0, 0, 0], yaw: 0, color }],
  }) as MapFileV2

describe('DraftStore', () => {
  it('writes a draft after the quiet period', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    expect(await h.storage.read('server-a/map.json')).toBeNull()
    await h.tick(1000)
    const saved = await h.storage.read('server-a/map.json')
    expect(saved?.baseRevision).toBe('rev-1')
    expect(saved?.map.statics[0]!.color).toBe('#111111')
  })

  it('debounces — a terrain stroke is one write, not hundreds', async () => {
    let writes = 0
    const inner = memoryDraftStorage()
    const counting: DraftStorage = {
      read: inner.read,
      remove: inner.remove,
      write: (k, r) => {
        writes++
        return inner.write(k, r)
      },
    }
    const h = harness({ storage: counting })
    for (let i = 0; i < 200; i++) h.store.noteChange(mapWith('#222222'), 'rev-1')
    await h.tick(1000)
    expect(writes).toBe(1)
  })

  it('keeps only the latest state', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    h.store.noteChange(mapWith('#999999'), 'rev-1')
    await h.tick(1000)
    expect((await h.storage.read('server-a/map.json'))!.map.statics[0]!.color).toBe('#999999')
  })

  it('flush() writes immediately, for a tab about to close', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.store.flush()
    expect(await h.storage.read('server-a/map.json')).not.toBeNull()
    expect(h.pending()).toBe(0)
  })

  it('offers a draft taken at the revision the editor has now', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.tick(1000)
    expect(await h.store.pendingDraft('rev-1')).not.toBeNull()
  })

  it('does NOT offer a draft whose parent revision is gone', async () => {
    // The map was saved since. The draft's parent no longer exists, so
    // applying it would silently revert whatever happened in between.
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.tick(1000)
    expect(await h.store.pendingDraft('rev-2')).toBeNull()
    // …but it is still offered for EXPORT, so the work is not simply lost.
    expect(await h.store.staleDraft('rev-2')).not.toBeNull()
  })

  it('never crosses maps', async () => {
    const shared = memoryDraftStorage()
    const a = harness({ mapKey: 'server-a/map.json', storage: shared })
    a.store.noteChange(mapWith('#111111'), 'rev-1')
    await a.tick(1000)
    const b = harness({ mapKey: 'server-b/map.json', storage: shared })
    expect(await b.store.pendingDraft('rev-1')).toBeNull()
  })

  it('discards a draft that has gone stale by age', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.tick(1000)
    await h.jump(DRAFT_MAX_AGE_MS + 1)
    expect(await h.store.pendingDraft('rev-1')).toBeNull()
    expect(await h.storage.read('server-a/map.json')).toBeNull()
  })

  it('removes the draft once the work is safely on the server', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.tick(1000)
    await h.store.markSaved()
    expect(await h.storage.read('server-a/map.json')).toBeNull()
  })

  it('markSaved cancels a write that had not fired yet', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.store.markSaved()
    await h.tick(1000)
    expect(await h.storage.read('server-a/map.json')).toBeNull()
  })

  it('discard() forgets the draft', async () => {
    const h = harness()
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.tick(1000)
    await h.store.discard()
    expect(await h.store.pendingDraft('rev-1')).toBeNull()
  })

  it('stores a detached copy — later edits do not rewrite the draft', async () => {
    const h = harness()
    const map = mapWith('#111111')
    h.store.noteChange(map, 'rev-1')
    await h.tick(1000)
    map.statics[0]!.color = '#abcdef'
    expect((await h.storage.read('server-a/map.json'))!.map.statics[0]!.color).toBe('#111111')
  })

  it('survives a storage backend that fails', async () => {
    // Private-mode browsers and blocked storage must not stop the editor.
    const broken: DraftStorage = {
      read: () => Promise.resolve(null),
      write: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    }
    const h = harness({ storage: broken })
    h.store.noteChange(mapWith('#111111'), 'rev-1')
    await h.tick(1000)
    expect(await h.store.pendingDraft('rev-1')).toBeNull()
  })
})
