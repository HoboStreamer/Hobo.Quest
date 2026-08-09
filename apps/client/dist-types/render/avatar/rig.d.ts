import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Appearance } from '@hobo/protocol'
/**
 * Parametric low-poly humanoid rig.
 *
 * A joint hierarchy of TransformNodes with flat-shaded tapered-box segments
 * parented to them — no skinning, fully data-driven from Appearance.
 *
 * Assembly rules that keep the body seamless:
 *  - every segment's top extends PAST its joint (OVERLAP) into the segment
 *    above, so bending never exposes gaps or interior top faces;
 *  - adjoining segment widths match at the junction (thigh bottom == shin
 *    top, etc.) so silhouettes stay continuous;
 *  - thigh + shin + foot exactly total the leg length, so feet stand ON the
 *    ground instead of clipping through it.
 *
 * Conventions: root origin at the FEET (ground). +Z faces forward (player
 * yaw). Limb joints rotate at the top of their segment.
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
  /** First person hides the arms too — the viewmodel represents them. */
  setArmsVisible(visible: boolean): void
  dispose(): void
}
export declare function buildAvatarRig(
  scene: Scene,
  appearance: Appearance,
  name: string,
): AvatarRig
//# sourceMappingURL=rig.d.ts.map
