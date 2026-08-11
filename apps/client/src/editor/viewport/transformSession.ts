/**
 * One transform gesture, from grab to commit.
 *
 * Replaces the previous workflow of parenting heterogeneous Babylon meshes to
 * a pivot TransformNode, dragging it, unparenting, and then baking each object
 * type back by hand in `bakeMulti()` — which had a separate branch per kind,
 * silently skipped scale for anything but statics, and read the CURRENT mesh
 * pose (already transformed) as its source.
 *
 * Here the session owns immutable START snapshots and recomputes every member
 * from them on each update, so a drag cannot compound, cancel is exact, and
 * the whole gesture commits as a single history entry.
 */
import {
  applyGroupDelta,
  centroidOf,
  cloneTransform,
  isFiniteTransform,
  type EditorTransform,
} from './transformMath.js'
import type { CommandHistory, EditorCommand } from '../history/commandHistory.js'

/** How the session reads and writes an object's canonical transform. */
export interface TransformAccessor {
  get(id: string): EditorTransform | null
  set(id: string, t: EditorTransform): void
}

export type TransformMode = 'move' | 'rotate' | 'scale'

export interface TransformSessionOptions {
  /** Called before the session starts; false aborts (e.g. lock denied). */
  acquireLocks?: (ids: string[]) => boolean
  /** Objects that may be moved but not written (read-only members). */
  isWritable?: (id: string) => boolean
  label?: string
}

export interface StartedSession {
  ids: string[]
  pivotStart: EditorTransform
}

export class TransformSession<TDoc = unknown> {
  private _ids: string[] = []
  private _starts: EditorTransform[] = []
  private _pivotStart: EditorTransform | null = null
  private _active = false
  private _label = 'transform'

  constructor(
    private readonly accessor: TransformAccessor,
    private readonly history: CommandHistory<TDoc>,
  ) {}

  get active(): boolean {
    return this._active
  }
  get ids(): readonly string[] {
    return this._ids
  }
  get pivotStart(): EditorTransform | null {
    return this._pivotStart
  }

  /**
   * Begin a gesture over `ids`. Returns null when nothing is transformable or
   * a required lock is refused — in that case NOTHING has been mutated and no
   * transaction is open, so the selection simply stays put.
   */
  begin(
    ids: readonly string[],
    mode: TransformMode,
    opts: TransformSessionOptions = {},
  ): StartedSession | null {
    if (this._active) return null
    const writable = ids.filter((id) => (opts.isWritable ? opts.isWritable(id) : true))
    const starts: EditorTransform[] = []
    const kept: string[] = []
    for (const id of writable) {
      const t = this.accessor.get(id)
      if (!t) continue
      kept.push(id)
      starts.push(cloneTransform(t))
    }
    if (kept.length === 0) return null
    // Locks are acquired for the WHOLE set atomically: a group transform that
    // could only move half its members is worse than one that does not start.
    if (opts.acquireLocks && !opts.acquireLocks(kept)) return null

    this._ids = kept
    this._starts = starts
    this._pivotStart = {
      position: centroidOf(starts),
      // The group pivot starts unrotated and unscaled so the gizmo reports
      // deltas, which is what the group inspector labels them as.
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    }
    this._active = true
    this._label = opts.label ?? `${mode} ${kept.length > 1 ? `${kept.length} objects` : kept[0]}`
    this.history.beginTransaction(this._label)
    return { ids: [...kept], pivotStart: cloneTransform(this._pivotStart) }
  }

  /**
   * Live preview: recompute every member from its START transform using the
   * pivot's current pose. Safe to call every frame.
   */
  update(pivotNow: EditorTransform): void {
    if (!this._active || !this._pivotStart) return
    const next = applyGroupDelta(this._starts, this._pivotStart, pivotNow)
    for (let i = 0; i < this._ids.length; i++) {
      const t = next[i]!
      // A degenerate pivot (zero scale, NaN from a bad numeric entry) must
      // never reach the document — skip the frame instead.
      if (!isFiniteTransform(t)) continue
      this.accessor.set(this._ids[i]!, t)
    }
  }

  /** Directly set one member (numeric inspector entry during a session). */
  setOne(id: string, t: EditorTransform): void {
    if (!isFiniteTransform(t)) return
    this.accessor.set(id, t)
  }

  /**
   * Finish: record ONE command carrying the start→end transforms of every
   * member. Returns false when nothing actually changed, in which case no
   * history entry is produced (a click on a handle is not an edit).
   */
  commit(): boolean {
    if (!this._active) return false
    const ids = this._ids
    const starts = this._starts
    const ends = ids.map((id) => this.accessor.get(id))
    const changed = ends.some((e, i) => e && !sameTransform(e, starts[i]!))
    if (!changed) {
      this.history.cancelTransaction()
      this._reset()
      return false
    }
    const finals = ends.map((e, i) => cloneTransform(e ?? starts[i]!))
    const accessor = this.accessor
    const cmd: EditorCommand<TDoc> = {
      label: this._label,
      estimatedBytes: 256 * ids.length,
      execute: () => {
        for (let i = 0; i < ids.length; i++) accessor.set(ids[i]!, cloneTransform(finals[i]!))
      },
      undo: () => {
        for (let i = 0; i < ids.length; i++) accessor.set(ids[i]!, cloneTransform(starts[i]!))
      },
    }
    // The document already holds the final state, so record without re-running.
    this.history.record(cmd)
    this.history.commitTransaction(this._label)
    this._reset()
    return true
  }

  /**
   * Abort: restore every member to its exact start snapshot and record
   * nothing. Used by Escape, a lost lock lease and a disconnect.
   */
  cancel(): void {
    if (!this._active) return
    for (let i = 0; i < this._ids.length; i++)
      this.accessor.set(this._ids[i]!, cloneTransform(this._starts[i]!))
    this.history.cancelTransaction()
    this._reset()
  }

  private _reset(): void {
    this._active = false
    this._ids = []
    this._starts = []
    this._pivotStart = null
  }
}

const EPS = 1e-6
export function sameTransform(a: EditorTransform, b: EditorTransform): boolean {
  return (
    a.position.every((v, i) => Math.abs(v - b.position[i]!) < EPS) &&
    a.scale.every((v, i) => Math.abs(v - b.scale[i]!) < EPS) &&
    a.rotation.every((v, i) => Math.abs(v - b.rotation[i]!) < EPS)
  )
}
