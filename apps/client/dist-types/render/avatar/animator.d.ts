import type { RigJoints } from './rig.js'
/**
 * Procedural animation for the avatar rig — no baked clips, so every state
 * blends smoothly into every other by construction: each frame computes a
 * TARGET pose (walk/run cycle, idle sway, airborne, tool aim) and the live
 * pose exponentially damps toward it. Locomotion phase advances with actual
 * horizontal speed, so foot cadence always matches the (predicted or
 * interpolated) motion driving it.
 */
export interface AnimatorInput {
  dt: number
  /** Wall time (s) for idle sway. */
  time: number
  /** Horizontal speed m/s. */
  speed: number
  grounded: boolean
  /** View pitch (radians, +up) for head/torso aim. */
  pitch: number
  /** Stance: 0 stand, 1 crouch, 2 prone. */
  stance: number
  /** Equipped tool kind for arm posing. */
  tool: 'physgun' | 'axe' | 'pickaxe' | 'hammer' | null
  /** Physgun beam currently latched (two-hand aim pose). */
  beamActive: boolean
}
export declare class AvatarAnimator {
  private readonly joints
  private phase
  private pose
  /** One-shot swing timer (s remaining); drives axe/pickaxe chop. */
  private swingT
  /** Smoothed grounded factor so landings ease instead of snapping. */
  private groundBlend
  constructor(joints: RigJoints)
  triggerSwing(): void
  update(input: AnimatorInput): void
}
//# sourceMappingURL=animator.d.ts.map
