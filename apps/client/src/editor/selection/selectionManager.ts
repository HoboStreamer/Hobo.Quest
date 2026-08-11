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

export class SelectionManager {
  private _ids = new Set<string>()
  private _primary: string | null = null
  /** Insertion order, so the inspector and gizmo pivot are stable. */
  private _order: string[] = []
  private _listeners = new Set<(s: SelectionSnapshot) => void>()
  /** While frozen (mid transform) selection mutations are refused. */
  private _frozen = false

  get primaryId(): string | null {
    return this._primary
  }
  get size(): number {
    return this._ids.size
  }
  get frozen(): boolean {
    return this._frozen
  }

  /** Ids in insertion order — primary first. */
  ids(): string[] {
    if (!this._primary) return [...this._order]
    return [this._primary, ...this._order.filter((i) => i !== this._primary)]
  }

  contains(id: string): boolean {
    return this._ids.has(id)
  }

  snapshot(): SelectionSnapshot {
    return { primaryId: this._primary, ids: this.ids() }
  }

  onChange(fn: (s: SelectionSnapshot) => void): () => void {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  /**
   * Freeze during a transform session: a drag must not be able to change
   * what it is dragging half way through (lost pointer, stray click,
   * remote update). Unfreeze restores normal behaviour.
   */
  freeze(): void {
    this._frozen = true
  }
  unfreeze(): void {
    this._frozen = false
  }

  replace(id: string | null): boolean {
    if (this._frozen) return false
    const next = id ? [id] : []
    if (this._sameAs(next) && this._primary === id) return false
    this._ids = new Set(next)
    this._order = [...next]
    this._primary = id
    this._emit()
    return true
  }

  replaceMany(ids: string[]): boolean {
    if (this._frozen) return false
    const uniq = [...new Set(ids)]
    if (this._sameAs(uniq) && this._primary === (uniq[0] ?? null)) return false
    this._ids = new Set(uniq)
    this._order = uniq
    this._primary = uniq[0] ?? null
    this._emit()
    return true
  }

  /** Ctrl+click: add, and make it primary. Already-selected stays selected. */
  add(id: string): boolean {
    if (this._frozen) return false
    if (this._ids.has(id)) {
      if (this._primary === id) return false
      this._primary = id
      this._emit()
      return true
    }
    this._ids.add(id)
    this._order.push(id)
    this._primary = id
    this._emit()
    return true
  }

  /** Alt+click on a SELECTED object: drop just that one. */
  remove(id: string): boolean {
    if (this._frozen) return false
    if (!this._ids.has(id)) return false
    this._ids.delete(id)
    this._order = this._order.filter((i) => i !== id)
    if (this._primary === id) this._primary = this._order[0] ?? null
    this._emit()
    return true
  }

  clear(): boolean {
    if (this._frozen) return false
    if (this._ids.size === 0 && this._primary === null) return false
    this._ids.clear()
    this._order = []
    this._primary = null
    this._emit()
    return true
  }

  /**
   * Apply the editor's click semantics in one place.
   *
   *   plain click on object  → replace
   *   ctrl  click on object  → add (idempotent)
   *   alt   click on object  → remove IF selected, otherwise nothing
   *   plain click on empty   → clear
   *   ctrl/alt click empty   → keep the selection
   */
  applyClick(hitId: string | null, mode: SelectMode): boolean {
    if (hitId === null) return mode === 'replace' ? this.clear() : false
    if (mode === 'add') return this.add(hitId)
    if (mode === 'remove') return this.contains(hitId) ? this.remove(hitId) : false
    return this.replace(hitId)
  }

  /**
   * Keep the selection meaningful when the document loses objects (undo of a
   * create, a remote delete): drop only the ids that vanished instead of
   * wiping the whole selection.
   */
  retain(existing: (id: string) => boolean): boolean {
    const keep = this._order.filter(existing)
    if (keep.length === this._order.length) return false
    this._order = keep
    this._ids = new Set(keep)
    if (this._primary && !this._ids.has(this._primary)) this._primary = keep[0] ?? null
    this._emit()
    return true
  }

  private _sameAs(next: string[]): boolean {
    if (next.length !== this._ids.size) return false
    return next.every((i) => this._ids.has(i))
  }

  private _emit(): void {
    const s = this.snapshot()
    for (const fn of this._listeners) fn(s)
  }
}

/** Modifier keys → selection mode. Shift is deliberately NOT a multi-select. */
export function selectModeFromEvent(e: {
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
}): SelectMode {
  if (e.altKey) return 'remove'
  if (e.ctrlKey || e.metaKey) return 'add'
  return 'replace'
}
