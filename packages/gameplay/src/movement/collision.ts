import type { Vec3 } from '@hobo/shared'

/**
 * The movement simulator's only view of the physical world. The physics
 * package implements this against Havok; tests implement it analytically.
 * Keeping movement pure over this interface is what lets the identical
 * code run for server authority and client prediction.
 */
export interface SweepHit {
  /** Fraction [0,1] along the sweep at first contact. */
  fraction: number
  normal: Vec3
  point: Vec3
}

export interface CollisionQueries {
  /**
   * Sweeps a vertical capsule (position = capsule center) from `from` to
   * `to`. Returns the earliest hit or null. Must exclude the moving player's
   * own body.
   */
  sweepCapsule(from: Vec3, to: Vec3, radius: number, height: number): SweepHit | null
}
