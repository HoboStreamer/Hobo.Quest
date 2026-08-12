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
import { type EditorTransform } from './transformMath.js'
import type { CommandHistory } from '../history/commandHistory.js'
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
export declare class TransformSession<TDoc = unknown> {
  private readonly accessor
  private readonly history
  private _ids
  private _starts
  private _pivotStart
  private _active
  private _label
  constructor(accessor: TransformAccessor, history: CommandHistory<TDoc>)
  get active(): boolean
  get ids(): readonly string[]
  get pivotStart(): EditorTransform | null
  /**
   * Begin a gesture over `ids`. Returns null when nothing is transformable or
   * a required lock is refused — in that case NOTHING has been mutated and no
   * transaction is open, so the selection simply stays put.
   */
  begin(
    ids: readonly string[],
    mode: TransformMode,
    opts?: TransformSessionOptions,
  ): StartedSession | null
  /**
   * Live preview: recompute every member from its START transform using the
   * pivot's current pose. Safe to call every frame.
   */
  update(pivotNow: EditorTransform): void
  /** Directly set one member (numeric inspector entry during a session). */
  setOne(id: string, t: EditorTransform): void
  /**
   * Finish: record ONE command carrying the start→end transforms of every
   * member. Returns false when nothing actually changed, in which case no
   * history entry is produced (a click on a handle is not an edit).
   */
  commit(): boolean
  /**
   * Abort: restore every member to its exact start snapshot and record
   * nothing. Used by Escape, a lost lock lease and a disconnect.
   */
  cancel(): void
  private _reset
}
export declare function sameTransform(a: EditorTransform, b: EditorTransform): boolean
//# sourceMappingURL=transformSession.d.ts.map
