/**
 * The ONE place document objects become Babylon meshes, and the ONE place a
 * picked mesh becomes a document id.
 *
 * Before this the editor kept five parallel `Map<Mesh, T>` tables plus a
 * `terrainTargets` array, and every one of them had to be kept in step by
 * hand: `deselect()` cleared some, a remote merge disposed others, undo
 * rebuilt a mesh and left a third pointing at a disposed one. Meshes are a
 * PROJECTION — they are rebuilt constantly — so nothing durable may point at
 * them. Selection, history, locks and the Outliner all hold ids; this maps
 * between the two and nothing else does.
 *
 * A view owns its meshes, materials and editor-only helper geometry, and is
 * responsible for keeping them in sync with the document object. Destroying
 * and rebuilding one cannot invalidate identity.
 */
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { EditorDocument, EditorObject, EditorObjectKind } from '../document/editorDocument.js'
/**
 * One object's Babylon projection.
 *
 * `update` gets the keys that changed so a view can be cheap about it — a
 * colour change must not rebuild a heightfield. Returning false means "I
 * cannot apply this incrementally", and the registry rebuilds the view.
 */
export interface EditorView {
  readonly id: string
  readonly kind: EditorObjectKind
  /** The node the gizmo attaches to and the Outliner frames. */
  readonly root: TransformNode
  /** Meshes that should be pickable/highlightable for this object. */
  meshes(): Mesh[]
  /** Apply a document change. False = rebuild me. */
  update(object: EditorObject, keys: readonly string[]): boolean
  /** Editor-only visibility (Outliner eye), not authored data. */
  setVisible(on: boolean): void
  dispose(): void
}
export type ViewFactory = (id: string, kind: EditorObjectKind, object: EditorObject) => EditorView
export declare class EditorViewRegistry {
  private readonly doc
  private readonly factory
  private readonly views
  /** Child mesh (any depth) → owning object id. */
  private readonly owners
  private unsubscribe
  constructor(doc: EditorDocument, factory: ViewFactory)
  /** Build views for everything currently in the document and follow it. */
  start(): void
  stop(): void
  get size(): number
  viewOf(id: string): EditorView | null
  ids(): string[]
  /** The document id that owns a picked mesh, walking up through children. */
  ownerOf(mesh: AbstractMesh | null | undefined): string | null
  /** Primary node for `id` — what the gizmo rides and the camera frames. */
  rootOf(id: string): TransformNode | null
  meshesOf(id: string): Mesh[]
  /** Every renderable mesh, for scene-wide passes (hover picking filters). */
  allMeshes(): Mesh[]
  /**
   * Force a view to be rebuilt from scratch — what a view asks for when a
   * change it cannot apply incrementally arrives (a shape swap, a resolution
   * change), and what a material rebuild goes through.
   */
  rebuild(id: string): void
  private apply
  private rebuildAll
  private create
  private index
  private destroy
  private disposeAll
  /**
   * Re-index a view's meshes after it changed them itself (a model finishing
   * an async load, a mesh swapped for a new shape). Cheap and idempotent.
   */
  reindex(id: string): void
}
//# sourceMappingURL=editorViewRegistry.d.ts.map
