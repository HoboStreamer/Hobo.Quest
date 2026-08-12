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
export declare const DRAFT_MAX_AGE_MS: number
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
export declare class DraftStore {
  private readonly storage
  private readonly mapKey
  private readonly debounceMs
  private readonly now
  private readonly schedule
  private readonly cancel
  private timer
  private queued
  /** In-flight write, so `flush()` can be awaited deterministically. */
  private writing
  constructor(opts: DraftStoreOptions)
  /**
   * Record a change. Debounced: a terrain stroke is hundreds of document
   * mutations and must not be hundreds of IndexedDB writes.
   */
  noteChange(map: MapFileV2, baseRevision: string): void
  /** Write any pending draft immediately (tab hidden, explicit flush). */
  flush(): Promise<void>
  /**
   * The draft worth offering, or null.
   *
   * Refuses a draft from a different map (restoring one map's work into
   * another is worse than losing it), one that is merely stale, and — the
   * subtle one — a draft whose base revision no longer matches: the map has
   * been saved since, so the draft's parent no longer exists and applying it
   * would silently revert whatever happened in between.
   */
  pendingDraft(currentRevision: string): Promise<DraftRecord | null>
  /** A draft that exists but does not apply cleanly — offer export only. */
  staleDraft(currentRevision: string): Promise<DraftRecord | null>
  /** After a successful server save the draft is obsolete. */
  markSaved(): Promise<void>
  discard(): Promise<void>
  private flushCancel
  private writeNow
}
/** In-memory storage — tests, and a fallback where IndexedDB is blocked. */
export declare function memoryDraftStorage(): DraftStorage
/**
 * IndexedDB storage. Chosen over localStorage because a sculpted map is
 * megabytes: localStorage is a synchronous ~5 MB budget shared with
 * everything else on the origin, and exceeding it throws mid-edit.
 *
 * Every failure resolves to "no draft" rather than throwing: private-mode
 * browsers and blocked storage must not stop the editor from opening.
 */
export declare function indexedDbDraftStorage(): DraftStorage
//# sourceMappingURL=draftStore.d.ts.map
