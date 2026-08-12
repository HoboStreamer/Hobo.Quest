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
 * Constraint descriptions — the sandbox constraint set.
 *
 * All anchors/axes are in the LOCAL space of their body; the adapter
 * preserves the bodies' relative pose at creation time (frames are derived
 * so "now" is the joint's zero). Angular quantities are radians, linear
 * are meters. 'weld' locks all six degrees of freedom; 'axis' (a free
 * bearing) is a hinge without limits, expressed at the gameplay layer.
 */
export interface ConstraintMotor {
  /** Target velocity: rad/s on hinge axes, m/s on slider axes. */
  targetVelocity: number
  /** Peak force/torque the drive may apply. */
  maxForce: number
}

export type ConstraintDesc =
  | { type: 'weld'; bodyA: BodyId; bodyB: BodyId }
  | {
      type: 'rope'
      bodyA: BodyId
      bodyB: BodyId
      anchorA: Vec3
      anchorB: Vec3
      /** Max anchor separation; the rope is slack below it. */
      length: number
      /** Pair collision (default true). Disable when a rigid joint already
       * links the pair — mixed collision flags on overlapped bodies store
       * explosive depenetration energy. */
      collision?: boolean
    }
  | {
      type: 'hinge'
      bodyA: BodyId
      bodyB: BodyId
      anchorA: Vec3
      anchorB: Vec3
      axisA: Vec3
      axisB: Vec3
      /** Swing limits about the axis; omitted = free bearing. */
      limits?: { min: number; max: number }
      /** Rotational friction (resists free swinging). */
      friction?: number
      motor?: ConstraintMotor
    }
  | {
      type: 'slider'
      bodyA: BodyId
      bodyB: BodyId
      anchorA: Vec3
      anchorB: Vec3
      axisA: Vec3
      axisB: Vec3
      /** Travel limits along the axis; omitted = unbounded rail. */
      limits?: { min: number; max: number }
      motor?: ConstraintMotor
    }
  | {
      type: 'spring'
      bodyA: BodyId
      bodyB: BodyId
      anchorA: Vec3
      anchorB: Vec3
      restLength: number
      stiffness: number
      damping: number
      /** Pair collision (default true); see rope. */
      collision?: boolean
    }

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
   * Creates a constraint between two bodies, preserving their current
   * relative pose (creation time is the joint's zero). Rigid joints (weld,
   * hinge, slider) disable collision between the pair; rope and spring
   * keep it.
   */
  addConstraint(desc: ConstraintDesc): ConstraintId
  removeConstraint(id: ConstraintId): void

  /** Retunes a motorized hinge/slider's drive. No-op on other constraints. */
  setConstraintMotor(id: ConstraintId, motor: ConstraintMotor): void

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
