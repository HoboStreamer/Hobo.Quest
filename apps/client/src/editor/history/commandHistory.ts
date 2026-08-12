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
export function snapshotCommand<TDoc, TState>(
  label: string,
  before: TState,
  after: TState,
  apply: (doc: TDoc, state: TState) => void,
  estimatedBytes?: number,
): EditorCommand<TDoc> {
  return {
    label,
    ...(estimatedBytes === undefined ? {} : { estimatedBytes }),
    execute: (doc) => apply(doc, after),
    undo: (doc) => apply(doc, before),
  }
}

/** Several commands committed and undone as one logical step. */
export function compositeCommand<TDoc>(
  label: string,
  parts: EditorCommand<TDoc>[],
): EditorCommand<TDoc> {
  return {
    label,
    estimatedBytes: parts.reduce((n, p) => n + (p.estimatedBytes ?? 1024), 0),
    execute: (doc) => {
      for (const p of parts) p.execute(doc)
    },
    // Undo in reverse: later parts may depend on earlier ones.
    undo: (doc) => {
      for (let i = parts.length - 1; i >= 0; i--) parts[i]!.undo(doc)
    },
  }
}

export interface HistoryState {
  depth: number
  redo: number
  dirty: boolean
  label: string | null
  bytes: number
}

export class CommandHistory<TDoc = unknown> {
  private _done: EditorCommand<TDoc>[] = []
  private _undone: EditorCommand<TDoc>[] = []
  /** Open transaction; commands accumulate here until commit. */
  private _txn: { label: string; parts: EditorCommand<TDoc>[] } | null = null
  /**
   * The command that was on top when we last saved. Comparing identity — not
   * stack depth — is what makes "undo back to the saved state clears dirty"
   * work while "undo, then do something else" stays dirty.
   */
  private _savedTop: EditorCommand<TDoc> | null = null
  private _listeners = new Set<(s: HistoryState) => void>()

  constructor(
    private readonly doc: TDoc,
    private readonly maxBytes = 48 * 1024 * 1024,
    private readonly maxEntries = 200,
  ) {}

  get inTransaction(): boolean {
    return this._txn !== null
  }
  get depth(): number {
    return this._done.length
  }
  get redoDepth(): number {
    return this._undone.length
  }

  state(): HistoryState {
    return {
      depth: this._done.length,
      redo: this._undone.length,
      dirty: this.isDirty(),
      label: this._done[this._done.length - 1]?.label ?? null,
      bytes: this._bytes(),
    }
  }

  isDirty(): boolean {
    return (this._done[this._done.length - 1] ?? null) !== this._savedTop
  }

  /** Mark the current state as saved; undoing back to it clears dirty. */
  markSaved(): void {
    this._savedTop = this._done[this._done.length - 1] ?? null
    this._emit()
  }

  /**
   * Run a command and record it. Inside a transaction the command is executed
   * immediately (so the viewport previews live) but only lands on the stack
   * when the transaction commits.
   */
  execute(cmd: EditorCommand<TDoc>): void {
    cmd.execute(this.doc)
    if (this._txn) {
      const last = this._txn.parts[this._txn.parts.length - 1]
      if (last?.coalesceWith?.(cmd)) return
      this._txn.parts.push(cmd)
      return
    }
    this._push(cmd)
  }

  /** Record a command WITHOUT running it (the caller already applied it). */
  /**
   * Run a command and record it. This is how document commands are issued:
   * one call, so a caller cannot apply a mutation and forget to make it
   * undoable, or record one it never applied.
   *
   * `record` is the older half of the pair, for mutations that were applied
   * by hand first; it exists only while the legacy paths are being retired.
   */
  apply(cmd: EditorCommand<TDoc>): void {
    cmd.execute(this.doc)
    this.record(cmd)
  }

  record(cmd: EditorCommand<TDoc>): void {
    if (this._txn) {
      const last = this._txn.parts[this._txn.parts.length - 1]
      if (last?.coalesceWith?.(cmd)) return
      this._txn.parts.push(cmd)
      return
    }
    this._push(cmd)
  }

  beginTransaction(label: string): void {
    // Nested begins keep the outermost label; commit closes the whole thing.
    if (this._txn) return
    this._txn = { label, parts: [] }
  }

  /** Close the transaction into ONE entry (or nothing, if it did nothing). */
  commitTransaction(label?: string): void {
    const txn = this._txn
    this._txn = null
    if (!txn || txn.parts.length === 0) return
    const name = label ?? txn.label
    this._push(
      txn.parts.length === 1
        ? { ...txn.parts[0]!, label: name }
        : compositeCommand(name, txn.parts),
    )
  }

  /** Roll the transaction back and record nothing (Escape mid-drag). */
  cancelTransaction(): void {
    const txn = this._txn
    this._txn = null
    if (!txn) return
    for (let i = txn.parts.length - 1; i >= 0; i--) txn.parts[i]!.undo(this.doc)
  }

  undo(): EditorCommand<TDoc> | null {
    if (this._txn) this.cancelTransaction()
    const cmd = this._done.pop()
    if (!cmd) return null
    cmd.undo(this.doc)
    this._undone.push(cmd)
    this._emit()
    return cmd
  }

  redo(): EditorCommand<TDoc> | null {
    const cmd = this._undone.pop()
    if (!cmd) return null
    cmd.execute(this.doc)
    this._done.push(cmd)
    this._emit()
    return cmd
  }

  /** Labels newest-first, for the history panel. */
  labels(): { label: string; undone: boolean }[] {
    return [
      ...[...this._done].reverse().map((c) => ({ label: c.label, undone: false })),
      ...this._undone.map((c) => ({ label: c.label, undone: true })),
    ]
  }

  clear(): void {
    this._done = []
    this._undone = []
    this._txn = null
    this._savedTop = null
    this._emit()
  }

  /**
   * The document was replaced wholesale (remote revision loaded). Past
   * commands reference objects that may no longer exist, so the stack is
   * dropped rather than left to corrupt the new document.
   */
  rebase(): void {
    this.clear()
  }

  onChange(fn: (s: HistoryState) => void): () => void {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  private _push(cmd: EditorCommand<TDoc>): void {
    this._done.push(cmd)
    this._undone.length = 0
    this._trim()
    this._emit()
  }

  private _bytes(): number {
    let n = 0
    for (const c of this._done) n += c.estimatedBytes ?? 1024
    for (const c of this._undone) n += c.estimatedBytes ?? 1024
    return n
  }

  /** Drop the oldest entries once the budget is exceeded. */
  private _trim(): void {
    while (
      this._done.length > this.maxEntries ||
      (this._bytes() > this.maxBytes && this._done.length > 1)
    ) {
      // A trimmed-away save marker leaves the document reading as dirty,
      // which is the safe direction.
      this._done.shift()
    }
  }

  private _emit(): void {
    const s = this.state()
    for (const fn of this._listeners) fn(s)
  }
}
