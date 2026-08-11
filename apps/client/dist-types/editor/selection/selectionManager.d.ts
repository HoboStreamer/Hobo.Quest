/**
 * The editor's single selection authority.
 *
 * Selection is a set of **document ids**, never Babylon meshes: meshes are
 * transient projections that get rebuilt by undo, remote merges and material
 * changes, so anything holding a mesh reference goes stale. Ids survive all
 * of that, which is what lets undo/redo keep a selection alive.
 *
 * `primaryId` is the selection's anchor — the object whose values the
 * inspector shows, and the one drawn in the strong highlight colour. It is
 * always a member of `selectedIds` (or null when the set is empty).
 */
/** Everything the editor can select. Face selection is separate. */
export type EditorObjectKind = 'static' | 'model' | 'terrain' | 'node' | 'prop' | 'spawn' | 'light'
export interface SelectionSnapshot {
  primaryId: string | null
  ids: string[]
}
/** How a click combines with the existing selection. */
export type SelectMode = 'replace' | 'add' | 'remove'
export declare class SelectionManager {
  private _ids
  private _primary
  /** Insertion order, so the inspector and gizmo pivot are stable. */
  private _order
  private _listeners
  /** While frozen (mid transform) selection mutations are refused. */
  private _frozen
  get primaryId(): string | null
  get size(): number
  get frozen(): boolean
  /** Ids in insertion order — primary first. */
  ids(): string[]
  contains(id: string): boolean
  snapshot(): SelectionSnapshot
  onChange(fn: (s: SelectionSnapshot) => void): () => void
  /**
   * Freeze during a transform session: a drag must not be able to change
   * what it is dragging half way through (lost pointer, stray click,
   * remote update). Unfreeze restores normal behaviour.
   */
  freeze(): void
  unfreeze(): void
  replace(id: string | null): boolean
  replaceMany(ids: string[]): boolean
  /** Ctrl+click: add, and make it primary. Already-selected stays selected. */
  add(id: string): boolean
  /** Alt+click on a SELECTED object: drop just that one. */
  remove(id: string): boolean
  clear(): boolean
  /**
   * Apply the editor's click semantics in one place.
   *
   *   plain click on object  → replace
   *   ctrl  click on object  → add (idempotent)
   *   alt   click on object  → remove IF selected, otherwise nothing
   *   plain click on empty   → clear
   *   ctrl/alt click empty   → keep the selection
   */
  applyClick(hitId: string | null, mode: SelectMode): boolean
  /**
   * Keep the selection meaningful when the document loses objects (undo of a
   * create, a remote delete): drop only the ids that vanished instead of
   * wiping the whole selection.
   */
  retain(existing: (id: string) => boolean): boolean
  private _sameAs
  private _emit
}
/** Modifier keys → selection mode. Shift is deliberately NOT a multi-select. */
export declare function selectModeFromEvent(e: {
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): SelectMode
//# sourceMappingURL=selectionManager.d.ts.map
