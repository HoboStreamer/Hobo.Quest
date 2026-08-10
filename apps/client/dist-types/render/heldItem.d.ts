import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry } from '@hobo/content'
/**
 * The one way ANY item becomes a visible in-hand model: tools use their
 * authored prop, everything else shows its actual world model (the same
 * shape/color it has when dropped) normalized to hand size. Third-person
 * hands and the first-person viewmodel both build from this, so an item
 * always looks like itself everywhere.
 */
export interface HeldItemNode {
  root: TransformNode
  /** Beam origin for physgun-style tools (null for ordinary items). */
  muzzle: TransformNode | null
  dispose(): void
}
export declare function createHeldItemNode(
  scene: Scene,
  content: ContentRegistry,
  defId: string,
  name: string,
): HeldItemNode | null
//# sourceMappingURL=heldItem.d.ts.map
