/**
 * Undo/redo as a stack of COMMANDS, replacing the old `UndoOp` union.
 *
 * The union had one variant per mutation shape (23 of them) and one giant
 * `applyOp` switch that reached directly into editor closures. Every new
 * feature added a variant and a branch, and every branch had to remember to
 * rebuild meshes, re-ground props and fix up selection.
 *
 * A command instead owns its own execute/undo pair, so the history has no
 * knowledge of what is being changed. Two rules make it dependable:
 *
 *  - ONE user interaction produces ONE entry. A transaction groups the
 *    intermediate states of a drag or a numeric scrub into a single command.
 *  - Undo must be an exact inverse. `history.test.ts` asserts
 *    before → execute → undo deep-equals before for every command type.
 */
export interface EditorCommand<TDoc = unknown> {
  /** Shown in the history panel; also used to coalesce scrubs. */
  label: string
  execute(document: TDoc): void
  undo(document: TDoc): void
  /** Rough retained size, for the memory budget. Defaults to 1 KB. */
  estimatedBytes?: number
  /**
   * Optional: fold a newer command of the same kind into this one, so a
   * continuous scrub stays a single entry. Return true if absorbed.
   */
  coalesceWith?(next: EditorCommand<TDoc>): boolean
}
/** A command built from two plain snapshots — the common case. */
export declare function snapshotCommand<TDoc, TState>(
  label: string,
  before: TState,
  after: TState,
  apply: (doc: TDoc, state: TState) => void,
  estimatedBytes?: number,
): EditorCommand<TDoc>
/** Several commands committed and undone as one logical step. */
export declare function compositeCommand<TDoc>(
  label: string,
  parts: EditorCommand<TDoc>[],
): EditorCommand<TDoc>
export interface HistoryState {
  depth: number
  redo: number
  dirty: boolean
  label: string | null
  bytes: number
}
export declare class CommandHistory<TDoc = unknown> {
  private readonly doc
  private readonly maxBytes
  private readonly maxEntries
  private _done
  private _undone
  /** Open transaction; commands accumulate here until commit. */
  private _txn
  /**
   * The command that was on top when we last saved. Comparing identity — not
   * stack depth — is what makes "undo back to the saved state clears dirty"
   * work while "undo, then do something else" stays dirty.
   */
  private _savedTop
  private _listeners
  constructor(doc: TDoc, maxBytes?: number, maxEntries?: number)
  get inTransaction(): boolean
  get depth(): number
  get redoDepth(): number
  state(): HistoryState
  isDirty(): boolean
  /** Mark the current state as saved; undoing back to it clears dirty. */
  markSaved(): void
  /**
   * Run a command and record it. Inside a transaction the command is executed
   * immediately (so the viewport previews live) but only lands on the stack
   * when the transaction commits.
   */
  execute(cmd: EditorCommand<TDoc>): void
  /** Record a command WITHOUT running it (the caller already applied it). */
  /**
   * Run a command and record it. This is how document commands are issued:
   * one call, so a caller cannot apply a mutation and forget to make it
   * undoable, or record one it never applied.
   *
   * `record` is the older half of the pair, for mutations that were applied
   * by hand first; it exists only while the legacy paths are being retired.
   */
  apply(cmd: EditorCommand<TDoc>): void
  record(cmd: EditorCommand<TDoc>): void
  beginTransaction(label: string): void
  /** Close the transaction into ONE entry (or nothing, if it did nothing). */
  commitTransaction(label?: string): void
  /** Roll the transaction back and record nothing (Escape mid-drag). */
  cancelTransaction(): void
  undo(): EditorCommand<TDoc> | null
  redo(): EditorCommand<TDoc> | null
  /** Labels newest-first, for the history panel. */
  labels(): {
    label: string
    undone: boolean
  }[]
  clear(): void
  /**
   * The document was replaced wholesale (remote revision loaded). Past
   * commands reference objects that may no longer exist, so the stack is
   * dropped rather than left to corrupt the new document.
   */
  rebase(): void
  onChange(fn: (s: HistoryState) => void): () => void
  private _push
  private _bytes
  /** Drop the oldest entries once the budget is exceeded. */
  private _trim
  private _emit
}
//# sourceMappingURL=commandHistory.d.ts.map
