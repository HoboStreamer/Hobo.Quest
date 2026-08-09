import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Appearance } from '@hobo/protocol'
/**
 * Parametric low-poly humanoid rig.
 *
 * A joint hierarchy of TransformNodes with flat-shaded tapered-box segments
 * parented to them — no skinning, in the spirit of the reference models but
 * fully data-driven: every proportion derives from Appearance (body type,
 * height, build) so customization needs no new assets. The animator poses
 * joints; rendering never touches physics or networking.
 *
 * Conventions: root origin at the FEET (ground). +Z faces forward (matches
 * player yaw). Limb joints rotate at the top of their segment.
 */
export interface RigJoints {
  root: TransformNode
  /** Vertical bob/lean node between root and pelvis. */
  bob: TransformNode
  spine: TransformNode
  chest: TransformNode
  neck: TransformNode
  head: TransformNode
  shoulderL: TransformNode
  shoulderR: TransformNode
  elbowL: TransformNode
  elbowR: TransformNode
  hipL: TransformNode
  hipR: TransformNode
  kneeL: TransformNode
  kneeR: TransformNode
  /** Attachment for held tools (right hand). */
  handR: TransformNode
}
export interface AvatarRig {
  joints: RigJoints
  /** Eye height above the root (for sanity checks / camera alignment). */
  eyeHeight: number
  setHeadVisible(visible: boolean): void
  dispose(): void
}
export declare function buildAvatarRig(
  scene: Scene,
  appearance: Appearance,
  name: string,
): AvatarRig
//# sourceMappingURL=rig.d.ts.map
