import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
/**
 * The one way ANY item becomes a visible in-hand model: tools use their
 * authored prop; everything else shows its actual world model (the same
 * shape/color it has when dropped), auto-fitted to the hand:
 *
 *  - uniformly scaled so its LONGEST dimension hits the requested grip
 *    size (viewmodel and third-person pass different sizes),
 *  - reoriented so elongated shapes lie across the palm (a log stands
 *    upright in the world but is carried horizontally),
 *  - grip-centered so the mesh pivots around where the hand holds it.
 *
 * Third-person hands and the first-person viewmodel both build from this,
 * so an item always looks like itself everywhere.
 */
export interface HeldItemNode {
  root: TransformNode
  /** Beam origin for physgun-style tools (null for ordinary items). */
  muzzle: TransformNode | null
  dispose(): void
}
/** Default grip size (third-person avatars). */
export declare const HAND_SIZE = 0.34
export declare function createHeldItemNode(
  scene: Scene,
  content: ContentRegistry,
  defId: string,
  name: string,
  gripSize?: number,
): HeldItemNode | null
//# sourceMappingURL=heldItem.d.ts.map
