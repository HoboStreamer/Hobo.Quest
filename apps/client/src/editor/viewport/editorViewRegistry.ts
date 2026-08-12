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
import type { DocumentChange } from '../document/editorDocument.js'

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

export class EditorViewRegistry {
  private readonly views = new Map<string, EditorView>()
  /** Child mesh (any depth) → owning object id. */
  private readonly owners = new Map<AbstractMesh, string>()
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly doc: EditorDocument,
    private readonly factory: ViewFactory,
  ) {}

  /** Build views for everything currently in the document and follow it. */
  start(): void {
    this.rebuildAll()
    this.unsubscribe = this.doc.subscribe((changes) => this.apply(changes))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.disposeAll()
  }

  get size(): number {
    return this.views.size
  }

  viewOf(id: string): EditorView | null {
    return this.views.get(id) ?? null
  }

  ids(): string[] {
    return [...this.views.keys()]
  }

  /** The document id that owns a picked mesh, walking up through children. */
  ownerOf(mesh: AbstractMesh | null | undefined): string | null {
    for (let n: AbstractMesh | null | undefined = mesh; n; n = n.parent as AbstractMesh | null) {
      const id = this.owners.get(n)
      if (id !== undefined) return id
    }
    return null
  }

  /** Primary node for `id` — what the gizmo rides and the camera frames. */
  rootOf(id: string): TransformNode | null {
    return this.views.get(id)?.root ?? null
  }

  meshesOf(id: string): Mesh[] {
    return this.views.get(id)?.meshes() ?? []
  }

  /** Every renderable mesh, for scene-wide passes (hover picking filters). */
  allMeshes(): Mesh[] {
    return [...this.views.values()].flatMap((v) => v.meshes())
  }

  /**
   * Force a view to be rebuilt from scratch — what a view asks for when a
   * change it cannot apply incrementally arrives (a shape swap, a resolution
   * change), and what a material rebuild goes through.
   */
  rebuild(id: string): void {
    const kind = this.doc.typeOf(id)
    const object = this.doc.get(id)
    this.destroy(id)
    if (kind === null || !object) return
    this.create(id, kind, object)
  }

  private apply(changes: readonly DocumentChange[]): void {
    for (const change of changes) {
      if (change.type === 'documentReplaced') {
        this.rebuildAll()
        return
      }
      // Asset metadata is not an object projection; the views that
      // reference a model rebuild through their own `updated` change.
      if (change.type === 'assetsChanged') continue
      if (change.type === 'removed') {
        this.destroy(change.id)
        continue
      }
      if (change.type === 'added') {
        const object = this.doc.get(change.id)
        if (object) this.create(change.id, change.kind, object)
        continue
      }
      const view = this.views.get(change.id)
      const object = this.doc.get(change.id)
      if (!object) continue
      if (!view) {
        this.create(change.id, change.kind, object)
        continue
      }
      const keys = change.type === 'updated' ? change.keys : Object.keys(object)
      // A view that cannot apply a change incrementally says so, and gets
      // rebuilt — identity is unaffected because it is keyed by id.
      if (!view.update(object, keys)) this.rebuild(change.id)
    }
  }

  private rebuildAll(): void {
    this.disposeAll()
    for (const object of this.doc.list()) {
      const kind = this.doc.typeOf(object.id)
      if (kind !== null) this.create(object.id, kind, object)
    }
  }

  private create(id: string, kind: EditorObjectKind, object: EditorObject): void {
    const view = this.factory(id, kind, object)
    this.views.set(id, view)
    this.index(view)
  }

  private index(view: EditorView): void {
    for (const m of view.meshes()) {
      this.owners.set(m, view.id)
      // Child meshes of an imported model resolve to the same owner without
      // being listed individually: `ownerOf` walks up. Registering the ones
      // we know about keeps that walk short.
      for (const child of m.getChildMeshes()) this.owners.set(child, view.id)
    }
  }

  private destroy(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    for (const [mesh, owner] of this.owners) if (owner === id) this.owners.delete(mesh)
    view.dispose()
    this.views.delete(id)
  }

  private disposeAll(): void {
    for (const view of this.views.values()) view.dispose()
    this.views.clear()
    this.owners.clear()
  }

  /**
   * Re-index a view's meshes after it changed them itself (a model finishing
   * an async load, a mesh swapped for a new shape). Cheap and idempotent.
   */
  reindex(id: string): void {
    const view = this.views.get(id)
    if (!view) return
    for (const [mesh, owner] of this.owners) if (owner === id) this.owners.delete(mesh)
    this.index(view)
  }
}
