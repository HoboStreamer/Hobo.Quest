import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import '@babylonjs/loaders/OBJ/objFileLoader.js'
import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js'
import type { ContentRegistry } from '@hobo/content'
import type { Appearance } from '@hobo/protocol'
/**
 * First-person viewmodel: the equipped tool rendered at the camera with
 * smooth sway (mouse lag), movement bob, and equip/swing motions. The
 * physgun uses the imported OBJ + texture; other tools use the procedural
 * props. Purely cosmetic — no gameplay reads anything from here.
 */
export declare class Viewmodel {
  private readonly scene
  private readonly content
  private readonly rig
  private physgunMeshes
  private toolProp
  private currentItem
  private physgunLoaded
  private swayYaw
  private swayPitch
  private bobPhase
  private equipT
  private swingT
  constructor(
    scene: Scene,
    content: ContentRegistry,
    camera: UniversalCamera,
    appearance: Appearance,
  )
  /**
   * First-person hands in the player's own skin tone: a forearm reaching in
   * from the lower right, gripping under the tool. Shown whenever an item
   * is equipped.
   */
  private hands
  /** Builds one first-person arm: outfit sleeve + cuff + skin fist with
   * knuckles and a thumb — matches the player's customized look. */
  private buildArm
  private leftFist
  private buildHands
  private loadPhysgun
  private setPhysgunVisible
  triggerSwing(): void
  /** Per-frame update. mouseDx/Dy are this frame's look deltas (radians). */
  update(dt: number, speed: number, grounded: boolean, mouseDx: number, mouseDy: number): void
  /** Switch displayed tool when the equipped item changes. */
  setItem(itemDef: string | null): void
  /**
   * The whole viewmodel renders in group 1: drawn AFTER world geometry and
   * beams (group 0), so the gun never clips into walls and beams never
   * overlap the gun — they visually emerge from behind its tip.
   */
  private applyRenderGroup
  /** World-space beam origin (the tool's muzzle tip). */
  beamOrigin(): Vector3
}
//# sourceMappingURL=viewmodel.d.ts.map
