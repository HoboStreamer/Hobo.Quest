/**
 * The editor's ONE picking entry point.
 *
 * A selection gesture asks this once and gets a single front-most eligible
 * hit. It replaces the old sequence of "pick ordinary meshes, then separately
 * multiPick terrain, then prefer the smallest patch within 1.5m", which could
 * return several objects for one click and made overlapping terrain
 * unpredictable.
 *
 * Two Babylon traps are handled here so no caller can forget them:
 *
 *  1. `scene.pick(x, y, predicate)` SKIPS the built-in isPickable / isVisible
 *     / isEnabled checks when a predicate is supplied. Every predicate we
 *     build therefore re-tests them itself — a deleted (disabled) island used
 *     to stay invisibly selectable because of exactly this.
 *  2. Gizmo geometry lives in a UtilityLayerRenderer scene, so it is not in
 *     the main scene's pick set at all; ownership of a gizmo gesture is
 *     decided by the InteractionController, never by ray distance.
 */
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { EditorObjectKind } from '../selection/selectionManager.js'
export interface EditorPick {
  objectId: string
  kind: EditorObjectKind
  mesh: AbstractMesh
  point: Vector3
  normal: Vector3 | null
  faceId: number
  distance: number
}
/** What a mesh in the viewport belongs to, or null for editor-only helpers. */
export interface MeshOwner {
  objectId: string
  kind: EditorObjectKind
}
/** Resolves a Babylon mesh to the document object that owns it. */
export type OwnerLookup = (mesh: AbstractMesh) => MeshOwner | null
export interface PickOptions {
  /** Restrict to these kinds (e.g. the Terrain tool only wants terrain). */
  kinds?: readonly EditorObjectKind[]
  /** Include water/other normally-excluded surfaces when explicitly wanted. */
  includeIds?: readonly string[]
}
/**
 * Walk a mesh up its parent chain until something claims ownership, so an
 * imported GLB's child meshes resolve to their owning editor object.
 * Returns null for sky, clouds, brush cursor, ghosts, wires, overlays and
 * peer avatars — anything no document object claims.
 */
export declare function resolveOwner(mesh: AbstractMesh, lookup: OwnerLookup): MeshOwner | null
/**
 * Pick the winner from a set of ray hits. Pure, so the tie-break rules are
 * testable without a scene.
 *
 * Nearest wins. For surfaces that are coincident within `epsilon` the object
 * id breaks the tie, which makes the result deterministic instead of
 * dependent on scene traversal order — the reason two stacked terrains used
 * to select unpredictably.
 */
export declare function resolveFrontMost<
  T extends {
    objectId: string
    distance: number
  },
>(hits: readonly T[], epsilon?: number): T | null
export declare class EditorPicker {
  private readonly scene
  private readonly lookup
  constructor(scene: Scene, lookup: OwnerLookup)
  /**
   * One click → at most one object. `scene.pick` already returns the nearest
   * hit, so this is a single traversal; `resolveFrontMost` only matters when
   * a caller supplies pre-collected hits.
   */
  pick(x: number, y: number, opts?: PickOptions): EditorPick | null
  /** Convenience for the current cursor position. */
  pickAtPointer(opts?: PickOptions): EditorPick | null
}
//# sourceMappingURL=editorPicker.d.ts.map
