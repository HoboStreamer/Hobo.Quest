import type { Quat, Vec3 } from '@hobo/shared'

/**
 * Engine-agnostic physics facade. Gameplay and server code depend on these
 * types only; the Havok/Babylon implementation lives behind `@hobo/physics/havok`
 * and no Havok or Babylon type ever crosses this boundary. That keeps
 * simulation testable without wasm and leaves room to swap/isolate the
 * engine (e.g. worker-side physics) later.
 */

/** Opaque handle to a body inside a PhysicsWorld instance. Not persistent — never serialize it. */
export type BodyId = number

/** Opaque handle to a constraint inside a PhysicsWorld instance. Not persistent. */
export type ConstraintId = number

/**
 * Constraint descriptions. 'weld' locks all six degrees of freedom at the
 * bodies' current relative pose. Future sandbox constraints (hinge, slider,
 * rope, spring, motor...) become new variants of this union.
 */
export type ConstraintDesc = { type: 'weld'; bodyA: BodyId; bodyB: BodyId }

/** Collision filter layers (bitmask). */
export const CollisionLayer = {
  Static: 1 << 0,
  Prop: 1 << 1,
  Player: 1 << 2,
} as const

export type ShapeDesc =
  | { type: 'box'; size: [number, number, number] }
  | { type: 'cylinder'; radius: number; height: number }
  | { type: 'sphere'; radius: number }
  | { type: 'capsule'; radius: number; height: number }
  /** Static triangle mesh (terrain). Positions/indices in local space. */
  | { type: 'trimesh'; positions: Float32Array; indices: Uint32Array }

export type MotionType = 'dynamic' | 'static' | 'kinematic'

export interface BodyDesc {
  shape: ShapeDesc
  motion: MotionType
  pos: Vec3
  rot?: Quat
  massKg?: number
  layer: number
  collidesWith: number
}

export interface RayHit {
  bodyId: BodyId
  point: Vec3
  normal: Vec3
  fraction: number
}

export interface SweepHit {
  fraction: number
  normal: Vec3
  point: Vec3
}

export interface PhysicsWorld {
  /** Advances the physics simulation by a fixed dt (seconds). */
  step(dt: number): void

  addBody(desc: BodyDesc): BodyId
  removeBody(id: BodyId): void

  getTransform(id: BodyId, outPos: Vec3, outRot: Quat): void
  /** Teleports a body; wakes it. */
  setTransform(id: BodyId, pos: Vec3, rot?: Quat): void
  setMotionType(id: BodyId, motion: MotionType): void

  getLinearVelocity(id: BodyId, out: Vec3): void
  setLinearVelocity(id: BodyId, v: Vec3): void
  getAngularVelocity(id: BodyId, out: Vec3): void
  setAngularVelocity(id: BodyId, v: Vec3): void

  /**
   * Settled = below velocity thresholds (the engine may also be sleeping it
   * internally). Server networking/persistence policy keys off this.
   */
  isSettled(id: BodyId): boolean
  wake(id: BodyId): void

  /**
   * Creates a constraint between two bodies (current relative pose is
   * preserved for 'weld'). Constrained bodies stop colliding with each other.
   */
  addConstraint(desc: ConstraintDesc): ConstraintId
  removeConstraint(id: ConstraintId): void

  /** First hit along a segment, filtered by collision mask. */
  raycast(from: Vec3, to: Vec3, collidesWith: number): RayHit | null

  /**
   * Sweeps a vertical capsule (pos = capsule center, total height incl caps)
   * between two points. Matches the shape of @hobo/gameplay CollisionQueries
   * structurally — the server/client bind it with a fixed mask.
   */
  sweepCapsule(
    from: Vec3,
    to: Vec3,
    radius: number,
    height: number,
    collidesWith: number,
    exclude?: BodyId,
  ): SweepHit | null

  dispose(): void
}
