/**
 * The scene graph, built from the DOCUMENT.
 *
 * Deliberately not from `scene.getNodes()`: Babylon's tree contains
 * wireframe overlays, light widgets, gizmo utility meshes, imported-model
 * hierarchies and the brush cursor, none of which are objects a user has any
 * business seeing, and it does not contain the one thing that matters — the
 * stable id. Reading the document gives exactly the authored objects, in a
 * stable order, with their identity.
 */
import type { EditorDocument, EditorObjectKind } from '../document/editorDocument.js'
export interface OutlinerRow {
  id: string
  kind: EditorObjectKind
  label: string
  icon: string
  group: string
}
export interface OutlinerState {
  selected: ReadonlySet<string>
  primary: string | null
  /** object id → collaborator colour, for remote selection. */
  remote: ReadonlyMap<string, string>
  /** object id → lock owner name. */
  locks: ReadonlyMap<string, string>
  /** Editor-only visibility (the eye toggle). */
  hidden: ReadonlySet<string>
  filter: string
}
export interface OutlinerCallbacks {
  onSelect: (id: string, mode: 'replace' | 'add' | 'subtract') => void
  onFocus: (id: string) => void
  onToggleVisible: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
}
export declare function buildRows(doc: EditorDocument, filter: string): OutlinerRow[]
export declare function groupRows(rows: readonly OutlinerRow[]): {
  group: string
  rows: OutlinerRow[]
}[]
/** Ctrl adds, Alt subtracts, a plain click replaces — same as the viewport. */
export declare function selectModeFor(e: {
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): 'replace' | 'add' | 'subtract'
export declare class Outliner {
  private readonly root
  private readonly doc
  private readonly callbacks
  private state
  /** The rows currently in the DOM, so a refresh can patch rather than rebuild. */
  private rendered
  constructor(root: HTMLElement, doc: EditorDocument, callbacks: OutlinerCallbacks)
  setFilter(filter: string): void
  setState(next: Partial<OutlinerState>): void
  /** Full rebuild — objects added or removed. */
  render(): void
  private renderRow
  /** Selection, remote colours and lock badges, without rebuilding rows. */
  private restyle
}
//# sourceMappingURL=outliner.d.ts.map
