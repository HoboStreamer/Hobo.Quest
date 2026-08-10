import type { Scene } from '@babylonjs/core/scene.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { ContentRegistry } from '@hobo/content'
import type { Appearance } from '@hobo/protocol'
/**
 * A complete animated player character: parametric rig + procedural
 * animator + held-item prop. Used identically for remote players, the
 * local first-person body (head hidden), and the customization preview.
 */
export interface AvatarUpdate {
  dt: number
  time: number
  x: number
  /** FEET height (capsule bottom). */
  y: number
  z: number
  yaw: number
  pitch: number
  speed: number
  grounded: boolean
  /** Stance: 0 stand, 1 crouch, 2 prone. */
  stance?: number
  /** Equipped item def id (drives held prop + arm pose). */
  itemDef?: string | undefined
  beamActive?: boolean
}
export declare class Avatar {
  private readonly scene
  private readonly content
  private appearance
  private readonly name
  private rig
  private animator
  private toolProp
  private toolItemDef
  private headVisible
  private armsVisible
  constructor(scene: Scene, content: ContentRegistry, appearance: Appearance, name: string)
  static appearanceOrDefault(a: Appearance | undefined): Appearance
  get eyeHeight(): number
  get rootPosition(): Vector3
  /** Rebuilds the rig (customization preview edits). Preserves pose state loosely. */
  setAppearance(appearance: Appearance): void
  setHeadVisible(visible: boolean): void
  setArmsVisible(visible: boolean): void
  triggerSwing(): void
  /** World position the physgun beam should start from (hand/muzzle). */
  beamOrigin(): Vector3
  update(u: AvatarUpdate): void
  dispose(): void
}
//# sourceMappingURL=avatar.d.ts.map
