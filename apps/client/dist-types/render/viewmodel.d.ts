import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Scene } from '@babylonjs/core/scene.js'
import '@babylonjs/loaders/OBJ/objFileLoader.js'
import type { UniversalCamera } from '@babylonjs/core/Cameras/universalCamera.js'
import type { ContentRegistry } from '@hobo/content'
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
  constructor(scene: Scene, content: ContentRegistry, camera: UniversalCamera)
  private loadPhysgun
  private setPhysgunVisible
  triggerSwing(): void
  /** Per-frame update. mouseDx/Dy are this frame's look deltas (radians). */
  update(dt: number, speed: number, grounded: boolean, mouseDx: number, mouseDy: number): void
  /** Switch displayed tool when the equipped item changes. */
  setItem(itemDef: string | null): void
  /** World-space beam origin (approximate muzzle). */
  beamOrigin(): Vector3
}
//# sourceMappingURL=viewmodel.d.ts.map
