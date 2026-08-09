/**
 * Source/Quake-inspired movement tuning. All values in meters/seconds.
 * Both server simulation and client prediction read the same instance —
 * a divergence here breaks prediction, so params travel with the build.
 */
export interface MovementParams {
  readonly maxGroundSpeed: number
  readonly maxSprintSpeed: number
  /** Ground acceleration factor (Quake sv_accelerate ~10). */
  readonly groundAccel: number
  /** Air acceleration factor. */
  readonly airAccel: number
  /** Max speed the air-accelerate projection can add toward wishdir — small cap enables air strafing. */
  readonly airSpeedCap: number
  /** Ground friction (Quake sv_friction ~6). */
  readonly friction: number
  /** Speed below which friction uses this as control value (crisp stops). */
  readonly stopSpeed: number
  readonly gravity: number
  readonly jumpSpeed: number
  /** Max walkable slope: ground when normal.y >= this (0.7 ≈ 45.5°). */
  readonly groundNormalY: number
  /** Max obstacle height the controller steps over. */
  readonly stepHeight: number
  /** Capsule dimensions: total height including caps, and radius. */
  readonly capsuleHeight: number
  readonly capsuleRadius: number
  /** Eye height above capsule center. */
  readonly eyeOffset: number
  /** Collision skin to keep the capsule from touching surfaces exactly. */
  readonly skin: number
  /** Hold-jump auto-hops when true (fun default for a sandbox). */
  readonly autoBhop: boolean
}

export const DEFAULT_MOVEMENT: MovementParams = {
  maxGroundSpeed: 5.2,
  maxSprintSpeed: 7.2,
  groundAccel: 10,
  airAccel: 12,
  airSpeedCap: 0.85,
  friction: 6,
  stopSpeed: 1.6,
  gravity: 20,
  jumpSpeed: 6.8,
  groundNormalY: 0.7,
  stepHeight: 0.45,
  capsuleHeight: 1.8,
  capsuleRadius: 0.4,
  eyeOffset: 0.65,
  skin: 0.02,
  autoBhop: true,
}
