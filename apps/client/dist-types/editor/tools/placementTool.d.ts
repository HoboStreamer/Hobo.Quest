/**
 * Placing things: the ghost preview, where a click lands, and what object
 * that becomes.
 *
 * Two behaviours worth naming:
 *
 * The BLANK-MAP BOOTSTRAP. A brand-new map has no geometry, so a placement
 * ray hits nothing and the first object could never be placed at all. When
 * the authored count is zero the first object commits at exactly the origin
 * wherever the user clicks — rather than the old answer, which was to keep a
 * hidden ground plane around purely so the ray had something to hit.
 *
 * SURFACE ALIGNMENT. A placed object's local +Y aligns to the surface normal,
 * so a box dropped on a slope sits on it rather than through it, and the
 * wheel yaw then turns it about that normal. Nodes, props and the spawn flag
 * stay upright regardless: a tree growing sideways out of a hill is never
 * what was meant.
 */
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { type MapModelV2, type StaticObjectV2 } from '@hobo/content'
import { type Placeable } from '../catalog.js'
import type { EditorObjectKind } from '../document/editorDocument.js'
export interface PlacePose {
  pos: Vector3
  rot: Quaternion
}
export interface PlacementContext {
  scene: Scene
  /** How many authored objects exist — drives the origin bootstrap. */
  authoredCount: () => number
  models: () => readonly MapModelV2[]
  /** Snap step in metres; 0 or a held bypass disables it. */
  snapStep: () => number
  snapBypassed: () => boolean
}
export declare const shapeHeight: (shape: StaticObjectV2['shape']) => number
export declare function placeableShape(
  def: Placeable,
  models: readonly MapModelV2[],
): StaticObjectV2['shape']
export declare class PlacementTool {
  private readonly ctx
  private ghost
  private ghostKey
  private yaw
  constructor(ctx: PlacementContext)
  get placeYaw(): number
  /** The wheel rotates the preview while a placement tool is active. */
  rotatePreview(delta: number): void
  resetYaw(): void
  private snap
  /** Build/refresh the translucent preview for `def`. */
  ensureGhost(def: Placeable | null, key: string): Mesh | null
  clearGhost(): void
  get preview(): Mesh | null
  /** Where the object would go, or null when the ray hits nothing. */
  computePose(def: Placeable | null): PlacePose | null
  updatePreview(def: Placeable | null, key: string): void
}
/**
 * The document object a placement produces. Returning the value rather than
 * inserting it keeps this pure — the caller wraps it in a command, which is
 * what makes placement undoable without this knowing history exists.
 */
export declare function objectForPlacement(
  def: Placeable,
  pose: PlacePose,
  models: readonly MapModelV2[],
): {
  kind: EditorObjectKind
  object: Record<string, unknown>
} | null
//# sourceMappingURL=placementTool.d.ts.map
