/**
 * Crash/reload recovery for unsaved editor work.
 *
 * Everything the editor holds lives in one tab's memory until Save. Close it,
 * reload it, or crash the GPU process, and an afternoon of terrain sculpting
 * is gone — the `beforeunload` prompt is a warning, not a safety net.
 *
 * A draft is the map DOCUMENT (not Babylon objects, which are a projection of
 * it) written to browser-local durable storage a moment after you stop typing.
 * It is NEVER published to the server: publishing is what Save means, and a
 * crash recovering itself into everyone else's world would be worse than
 * losing the work. On startup, if a draft exists for THIS map at a revision
 * the editor recognises, the user is offered it.
 *
 * Storage is injected so the logic is testable without IndexedDB; the browser
 * binding is `indexedDbDraftStorage()` below.
 */
import type { MapFileV2 } from '@hobo/content'

export interface DraftRecord {
  /** Which map this belongs to — never restore one map's work into another. */
  mapKey: string
  /** The revision the editor had loaded when the draft was taken. */
  baseRevision: string
  /** Epoch millis, for "saved 3 minutes ago" and for discarding stale drafts. */
  savedAt: number
  map: MapFileV2
}

/** The minimum a backing store must do. IndexedDB, memory, or a test fake. */
export interface DraftStorage {
  read(key: string): Promise<DraftRecord | null>
  write(key: string, record: DraftRecord): Promise<void>
  remove(key: string): Promise<void>
}

/** Drafts older than this are not offered; the map has moved on. */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface DraftStoreOptions {
  storage: DraftStorage
  /** Identity of the map being edited (server origin + path). */
  mapKey: string
  /** Quiet period after the last change before writing. */
  debounceMs?: number
  now?: () => number
  /** Injected so tests do not wait on real time. */
  schedule?: (fn: () => void, ms: number) => unknown
  cancel?: (handle: unknown) => void
}

export class DraftStore {
  private readonly storage: DraftStorage
  private readonly mapKey: string
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => unknown
  private readonly cancel: (handle: unknown) => void

  private timer: unknown = null
  private queued: { map: MapFileV2; baseRevision: string } | null = null
  /** In-flight write, so `flush()` can be awaited deterministically. */
  private writing: Promise<void> = Promise.resolve()

  constructor(opts: DraftStoreOptions) {
    this.storage = opts.storage
    this.mapKey = opts.mapKey
    this.debounceMs = opts.debounceMs ?? 1500
    this.now = opts.now ?? (() => Date.now())
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /**
   * Record a change. Debounced: a terrain stroke is hundreds of document
   * mutations and must not be hundreds of IndexedDB writes.
   */
  noteChange(map: MapFileV2, baseRevision: string): void {
    this.queued = { map, baseRevision }
    if (this.timer !== null) this.cancel(this.timer)
    this.timer = this.schedule(() => {
      this.timer = null
      this.writing = this.writeNow()
    }, this.debounceMs)
  }

  /** Write any pending draft immediately (tab hidden, explicit flush). */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
      this.writing = this.writeNow()
    }
    await this.writing
  }

  /**
   * The draft worth offering, or null.
   *
   * Refuses a draft from a different map (restoring one map's work into
   * another is worse than losing it), one that is merely stale, and — the
   * subtle one — a draft whose base revision no longer matches: the map has
   * been saved since, so the draft's parent no longer exists and applying it
   * would silently revert whatever happened in between.
   */
  async pendingDraft(currentRevision: string): Promise<DraftRecord | null> {
    const draft = await this.storage.read(this.mapKey)
    if (!draft) return null
    if (draft.mapKey !== this.mapKey) return null
    if (this.now() - draft.savedAt > DRAFT_MAX_AGE_MS) {
      await this.discard()
      return null
    }
    if (draft.baseRevision !== currentRevision) return null
    return draft
  }

  /** A draft that exists but does not apply cleanly — offer export only. */
  async staleDraft(currentRevision: string): Promise<DraftRecord | null> {
    const draft = await this.storage.read(this.mapKey)
    if (!draft || draft.mapKey !== this.mapKey) return null
    return draft.baseRevision === currentRevision ? null : draft
  }

  /** After a successful server save the draft is obsolete. */
  async markSaved(): Promise<void> {
    await this.flushCancel()
    await this.storage.remove(this.mapKey)
  }

  async discard(): Promise<void> {
    await this.flushCancel()
    await this.storage.remove(this.mapKey)
  }

  private async flushCancel(): Promise<void> {
    if (this.timer !== null) {
      this.cancel(this.timer)
      this.timer = null
    }
    this.queued = null
    await this.writing
  }

  private async writeNow(): Promise<void> {
    const pending = this.queued
    if (!pending) return
    this.queued = null
    await this.storage.write(this.mapKey, {
      mapKey: this.mapKey,
      baseRevision: pending.baseRevision,
      savedAt: this.now(),
      map: pending.map,
    })
  }
}

/** In-memory storage — tests, and a fallback where IndexedDB is blocked. */
export function memoryDraftStorage(): DraftStorage {
  const rows = new Map<string, DraftRecord>()
  return {
    read: (k) => Promise.resolve(rows.get(k) ?? null),
    write: (k, r) => {
      rows.set(k, structuredClone(r))
      return Promise.resolve()
    },
    remove: (k) => {
      rows.delete(k)
      return Promise.resolve()
    },
  }
}

const DB_NAME = 'hobo-editor'
const STORE = 'drafts'

/**
 * IndexedDB storage. Chosen over localStorage because a sculpted map is
 * megabytes: localStorage is a synchronous ~5 MB budget shared with
 * everything else on the origin, and exceeding it throws mid-edit.
 *
 * Every failure resolves to "no draft" rather than throwing: private-mode
 * browsers and blocked storage must not stop the editor from opening.
 */
export function indexedDbDraftStorage(): DraftStorage {
  const open = (): Promise<IDBDatabase | null> =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
      } catch {
        resolve(null)
      }
    })

  const run = <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest,
    fallback: T,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve) => {
          if (!db) return resolve(fallback)
          try {
            const tx = db.transaction(STORE, mode)
            const req = body(tx.objectStore(STORE))
            req.onsuccess = () => resolve((req.result as T) ?? fallback)
            req.onerror = () => resolve(fallback)
            tx.oncomplete = () => db.close()
          } catch {
            resolve(fallback)
          }
        }),
    )

  return {
    read: (k) => run<DraftRecord | null>('readonly', (s) => s.get(k), null),
    write: (k, r) => run<void>('readwrite', (s) => s.put(r, k), undefined),
    remove: (k) => run<void>('readwrite', (s) => s.delete(k), undefined),
  }
}
