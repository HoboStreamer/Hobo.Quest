import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { PhysicsRaycastResult } from '@babylonjs/core/Physics/physicsRaycastResult.js'
import { ShapeCastResult } from '@babylonjs/core/Physics/shapeCastResult.js'
import { HavokPlugin } from '@babylonjs/core/Physics/v2/Plugins/havokPlugin.js'
import {
  PhysicsActivationControl,
  PhysicsMotionType,
  PhysicsPrestepType,
} from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js'
import { PhysicsBody } from '@babylonjs/core/Physics/v2/physicsBody.js'
import type { PhysicsShape } from '@babylonjs/core/Physics/v2/physicsShape.js'
import {
  PhysicsShapeBox,
  PhysicsShapeCapsule,
  PhysicsShapeCylinder,
  PhysicsShapeMesh,
  PhysicsShapeSphere,
} from '@babylonjs/core/Physics/v2/physicsShape.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import {
  Physics6DoFConstraint,
  PhysicsConstraint,
  SpringConstraint,
} from '@babylonjs/core/Physics/v2/physicsConstraint.js'
import {
  PhysicsConstraintAxis,
  PhysicsConstraintMotorType,
  PhysicsConstraintType,
} from '@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js'
import { Scene } from '@babylonjs/core/scene.js'
import '@babylonjs/core/Physics/joinedPhysicsEngineComponent.js'
import type { Quat, Vec3 } from '@hobo/shared'
import type {
  BodyDesc,
  BodyId,
  ConstraintDesc,
  ConstraintId,
  ConstraintMotor,
  MotionType,
  PhysicsWorld,
  RayHit,
  ShapeDesc,
  SweepHit,
} from '../types.js'
import { CollisionLayer } from '../types.js'

/**
 * Havok (via Babylon Physics V2) implementation of PhysicsWorld.
 *
 * The same adapter runs headless on the server (NullEngine scene, never
 * rendered) and inside the client's rendered scene. Stepping is always
 * manual through `plugin.executeStep` from the fixed-timestep loop — the
 * scene's own render-driven physics stepping is disabled so simulation can
 * never couple to frame rate.
 */

interface BodyRecord {
  body: PhysicsBody
  node: TransformNode
  shape: PhysicsShape
  motion: MotionType
}

const MOTION_MAP: Record<MotionType, PhysicsMotionType> = {
  dynamic: PhysicsMotionType.DYNAMIC,
  static: PhysicsMotionType.STATIC,
  kinematic: PhysicsMotionType.ANIMATED,
}

const SETTLE_LIN_SQ = 0.05 * 0.05
const SETTLE_ANG_SQ = 0.15 * 0.15

export class HavokWorld implements PhysicsWorld {
  private nextId: BodyId = 1
  private nextConstraintId: ConstraintId = 1
  private readonly bodies = new Map<BodyId, BodyRecord>()
  private readonly constraints = new Map<
    ConstraintId,
    { constraint: PhysicsConstraint; type: ConstraintDesc['type'] }
  >()
  private readonly bodyIds = new WeakMap<PhysicsBody, BodyId>()
  private bodyList: PhysicsBody[] = []
  private bodyListDirty = false

  // Scratch objects — adapter methods are not re-entrant.
  private readonly _v1 = new Vector3()
  private readonly _v2 = new Vector3()
  private readonly _q1 = new Quaternion()
  private readonly _rayResult = new PhysicsRaycastResult()
  private readonly _castInput = new ShapeCastResult()
  private readonly _castHit = new ShapeCastResult()
  private readonly sweepShapes = new Map<string, PhysicsShapeCapsule>()

  constructor(
    private readonly scene: Scene,
    private readonly plugin: HavokPlugin,
    private readonly ownsScene: boolean,
  ) {}

  step(dt: number): void {
    if (this.bodyListDirty) {
      this.bodyList = [...this.bodies.values()].map((r) => r.body)
      this.bodyListDirty = false
    }
    this.plugin.executeStep(dt, this.bodyList)
  }

  addBody(desc: BodyDesc): BodyId {
    const id = this.nextId++
    const node = new TransformNode(`body:${id}`, this.scene)
    node.position.set(desc.pos.x, desc.pos.y, desc.pos.z)
    node.rotationQuaternion = desc.rot
      ? new Quaternion(desc.rot.x, desc.rot.y, desc.rot.z, desc.rot.w)
      : Quaternion.Identity()

    const shape = this.makeShape(desc.shape)
    shape.filterMembershipMask = desc.layer
    shape.filterCollideMask = desc.collidesWith
    // Grippy, dead-on-impact surfaces: Source props bite the ground instead
    // of gliding (Havok defaults are ice-like) and barely bounce.
    shape.material = { friction: 0.75, staticFriction: 0.85, restitution: 0.05 }

    const body = new PhysicsBody(node, MOTION_MAP[desc.motion], false, this.scene)
    body.shape = shape
    if (desc.motion === 'dynamic') {
      body.setMassProperties({ mass: desc.massKg ?? 10 })
      // Light linear + strong angular damping kill the floaty drift and
      // endless micro-rolling that read as "low gravity".
      body.setLinearDamping(0.05)
      body.setAngularDamping(0.6)
    }

    this.bodies.set(id, { body, node, shape, motion: desc.motion })
    this.bodyIds.set(body, id)
    this.bodyListDirty = true
    return id
  }

  removeBody(id: BodyId): void {
    const rec = this.bodies.get(id)
    if (!rec) return
    rec.body.dispose()
    rec.shape.dispose()
    rec.node.dispose()
    this.bodies.delete(id)
    this.bodyListDirty = true
  }

  getTransform(id: BodyId, outPos: Vec3, outRot: Quat): void {
    const rec = this.mustGet(id)
    const p = rec.node.position
    outPos.x = p.x
    outPos.y = p.y
    outPos.z = p.z
    const q = rec.node.rotationQuaternion
    if (q) {
      outRot.x = q.x
      outRot.y = q.y
      outRot.z = q.z
      outRot.w = q.w
    }
  }

  setTransform(id: BodyId, pos: Vec3, rot?: Quat): void {
    const rec = this.mustGet(id)
    rec.node.position.set(pos.x, pos.y, pos.z)
    if (rot && rec.node.rotationQuaternion) {
      rec.node.rotationQuaternion.set(rot.x, rot.y, rot.z, rot.w)
    }
    if (rec.motion === 'kinematic') {
      // ANIMATED bodies chase the node target with computed velocity so they
      // push dynamic bodies convincingly.
      this._v1.set(pos.x, pos.y, pos.z)
      const q = rec.node.rotationQuaternion ?? Quaternion.Identity()
      rec.body.setTargetTransform(this._v1, q)
    } else {
      // CRITICAL: with the default prestep (DISABLED),
      // setPhysicsBodyTransformation is a silent no-op — static mirror
      // bodies would never actually move. Flip to TELEPORT for the call.
      rec.body.setPrestepType(PhysicsPrestepType.TELEPORT)
      this.plugin.setPhysicsBodyTransformation(rec.body, rec.node)
      rec.body.setPrestepType(PhysicsPrestepType.DISABLED)
      this.wake(id)
    }
  }

  setMotionType(id: BodyId, motion: MotionType): void {
    const rec = this.mustGet(id)
    if (rec.motion === motion) return
    rec.body.setMotionType(MOTION_MAP[motion])
    rec.motion = motion
    if (motion === 'dynamic') {
      this.wake(id)
    }
  }

  getLinearVelocity(id: BodyId, out: Vec3): void {
    this.mustGet(id).body.getLinearVelocityToRef(this._v1)
    out.x = this._v1.x
    out.y = this._v1.y
    out.z = this._v1.z
  }

  setLinearVelocity(id: BodyId, v: Vec3): void {
    this._v1.set(v.x, v.y, v.z)
    this.mustGet(id).body.setLinearVelocity(this._v1)
  }

  getAngularVelocity(id: BodyId, out: Vec3): void {
    this.mustGet(id).body.getAngularVelocityToRef(this._v1)
    out.x = this._v1.x
    out.y = this._v1.y
    out.z = this._v1.z
  }

  setAngularVelocity(id: BodyId, v: Vec3): void {
    this._v1.set(v.x, v.y, v.z)
    this.mustGet(id).body.setAngularVelocity(this._v1)
  }

  isSettled(id: BodyId): boolean {
    const rec = this.mustGet(id)
    if (rec.motion !== 'dynamic') return true
    rec.body.getLinearVelocityToRef(this._v1)
    if (this._v1.lengthSquared() > SETTLE_LIN_SQ) return false
    rec.body.getAngularVelocityToRef(this._v1)
    return this._v1.lengthSquared() <= SETTLE_ANG_SQ
  }

  wake(id: BodyId): void {
    const rec = this.mustGet(id)
    if (rec.motion !== 'dynamic') return
    // Toggling activation control is the portable way to wake a Havok body
    // without disturbing its velocities.
    this.plugin.setActivationControl(rec.body, PhysicsActivationControl.ALWAYS_ACTIVE)
    this.plugin.setActivationControl(rec.body, PhysicsActivationControl.SIMULATION_CONTROLLED)
  }

  addConstraint(desc: ConstraintDesc): ConstraintId {
    const recA = this.mustGet(desc.bodyA)
    const recB = this.mustGet(desc.bodyB)
    const constraint = this.buildConstraint(desc, recA, recB)
    recA.body.addConstraint(recB.body, constraint)
    // Motors must be configured AFTER the joint exists in the engine.
    if ((desc.type === 'hinge' || desc.type === 'slider') && desc.motor) {
      const axis =
        desc.type === 'hinge' ? PhysicsConstraintAxis.ANGULAR_X : PhysicsConstraintAxis.LINEAR_X
      const c = constraint as Physics6DoFConstraint
      c.setAxisMotorType(axis, PhysicsConstraintMotorType.VELOCITY)
      c.setAxisMotorTarget(axis, desc.motor.targetVelocity)
      c.setAxisMotorMaxForce(axis, desc.motor.maxForce)
    }
    if (desc.type === 'hinge' && desc.friction !== undefined) {
      ;(constraint as Physics6DoFConstraint).setAxisFriction(
        PhysicsConstraintAxis.ANGULAR_X,
        desc.friction,
      )
    }
    const id = this.nextConstraintId++
    this.constraints.set(id, { constraint, type: desc.type })
    if (recA.motion === 'dynamic') this.wake(desc.bodyA)
    if (recB.motion === 'dynamic') this.wake(desc.bodyB)
    return id
  }

  private buildConstraint(
    desc: ConstraintDesc,
    recA: BodyRecord,
    recB: BodyRecord,
  ): PhysicsConstraint {
    switch (desc.type) {
      case 'weld': {
        const rotA = recA.node.rotationQuaternion ?? Quaternion.Identity()
        const rotB = recB.node.rotationQuaternion ?? Quaternion.Identity()
        // Anchor frames preserving the CURRENT relative pose:
        // pivotA = B's origin in A's local space; axes = B's basis in A's space.
        const invRotA = rotA.conjugate()
        const relRot = invRotA.multiply(rotB)
        const pivotA = recB.node.position
          .subtract(recA.node.position)
          .applyRotationQuaternion(invRotA)
        const axisA = new Vector3(1, 0, 0).applyRotationQuaternion(relRot)
        const perpA = new Vector3(0, 1, 0).applyRotationQuaternion(relRot)
        return new PhysicsConstraint(
          PhysicsConstraintType.LOCK,
          {
            pivotA,
            pivotB: Vector3.Zero(),
            axisA,
            axisB: new Vector3(1, 0, 0),
            perpAxisA: perpA,
            perpAxisB: new Vector3(0, 1, 0),
            collision: false,
          },
          this.scene,
        )
      }
      case 'rope':
        // A pure max-distance tether: slack below `length`, taut at it.
        // The pair keeps colliding — a crate on a rope bonks the post.
        return new PhysicsConstraint(
          PhysicsConstraintType.DISTANCE,
          {
            pivotA: toBjs(desc.anchorA),
            pivotB: toBjs(desc.anchorB),
            maxDistance: desc.length,
            collision: true,
          },
          this.scene,
        )
      case 'spring':
        // Soft equality at restLength: force = stiffness·error − damping·vel.
        return new SpringConstraint(
          toBjs(desc.anchorA),
          toBjs(desc.anchorB),
          new Vector3(1, 0, 0),
          new Vector3(1, 0, 0),
          desc.restLength,
          desc.restLength,
          desc.stiffness,
          desc.damping,
          this.scene,
        )
      case 'hinge':
      case 'slider': {
        const frames = jointFrames(desc.axisA, desc.axisB, recA, recB)
        const limits: { axis: PhysicsConstraintAxis; minLimit: number; maxLimit: number }[] = []
        const lock = (axis: PhysicsConstraintAxis) =>
          limits.push({ axis, minLimit: 0, maxLimit: 0 })
        if (desc.type === 'hinge') {
          lock(PhysicsConstraintAxis.LINEAR_X)
          lock(PhysicsConstraintAxis.LINEAR_Y)
          lock(PhysicsConstraintAxis.LINEAR_Z)
          lock(PhysicsConstraintAxis.ANGULAR_Y)
          lock(PhysicsConstraintAxis.ANGULAR_Z)
          if (desc.limits) {
            limits.push({
              axis: PhysicsConstraintAxis.ANGULAR_X,
              minLimit: desc.limits.min,
              maxLimit: desc.limits.max,
            })
          }
        } else {
          lock(PhysicsConstraintAxis.LINEAR_Y)
          lock(PhysicsConstraintAxis.LINEAR_Z)
          lock(PhysicsConstraintAxis.ANGULAR_X)
          lock(PhysicsConstraintAxis.ANGULAR_Y)
          lock(PhysicsConstraintAxis.ANGULAR_Z)
          if (desc.limits) {
            limits.push({
              axis: PhysicsConstraintAxis.LINEAR_X,
              minLimit: desc.limits.min,
              maxLimit: desc.limits.max,
            })
          }
        }
        return new Physics6DoFConstraint(
          {
            pivotA: toBjs(desc.anchorA),
            pivotB: toBjs(desc.anchorB),
            axisA: frames.axisA,
            axisB: frames.axisB,
            perpAxisA: frames.perpA,
            perpAxisB: frames.perpB,
            collision: false,
          },
          limits,
          this.scene,
        )
      }
    }
  }

  setConstraintMotor(id: ConstraintId, motor: ConstraintMotor): void {
    const rec = this.constraints.get(id)
    if (!rec || (rec.type !== 'hinge' && rec.type !== 'slider')) return
    const axis =
      rec.type === 'hinge' ? PhysicsConstraintAxis.ANGULAR_X : PhysicsConstraintAxis.LINEAR_X
    const c = rec.constraint as Physics6DoFConstraint
    c.setAxisMotorType(axis, PhysicsConstraintMotorType.VELOCITY)
    c.setAxisMotorTarget(axis, motor.targetVelocity)
    c.setAxisMotorMaxForce(axis, motor.maxForce)
  }

  removeConstraint(id: ConstraintId): void {
    const rec = this.constraints.get(id)
    if (!rec) return
    rec.constraint.dispose()
    this.constraints.delete(id)
  }

  raycast(from: Vec3, to: Vec3, collidesWith: number): RayHit | null {
    this._v1.set(from.x, from.y, from.z)
    this._v2.set(to.x, to.y, to.z)
    this.plugin.raycast(this._v1, this._v2, this._rayResult, {
      membership: 0xffffffff,
      collideWith: collidesWith,
    })
    const r = this._rayResult
    if (!r.hasHit || !r.body) return null
    const bodyId = this.bodyIds.get(r.body)
    if (bodyId === undefined) return null
    return {
      bodyId,
      point: { x: r.hitPointWorld.x, y: r.hitPointWorld.y, z: r.hitPointWorld.z },
      normal: { x: r.hitNormalWorld.x, y: r.hitNormalWorld.y, z: r.hitNormalWorld.z },
      fraction: r.hitDistance / Math.max(this._v2.subtract(this._v1).length(), 1e-9),
    }
  }

  sweepCapsule(
    from: Vec3,
    to: Vec3,
    radius: number,
    height: number,
    collidesWith: number,
    exclude?: BodyId,
  ): SweepHit | null {
    const shape = this.getSweepShape(radius, height, collidesWith)
    this._v1.set(from.x, from.y, from.z)
    this._v2.set(to.x, to.y, to.z)
    this._q1.set(0, 0, 0, 1)
    // ignoreBody lets a player's movement sweep collide with the Player
    // layer without hitting their own kinematic body.
    const ignoreBody = exclude === undefined ? undefined : this.bodies.get(exclude)?.body
    this.plugin.shapeCast(
      {
        shape,
        rotation: this._q1,
        startPosition: this._v1,
        endPosition: this._v2,
        shouldHitTriggers: false,
        ...(ignoreBody ? { ignoreBody } : {}),
      },
      this._castInput,
      this._castHit,
    )
    if (!this._castHit.hasHit) return null
    const n = this._castHit.hitNormal
    const p = this._castHit.hitPoint
    return {
      fraction: this._castHit.hitFraction,
      normal: { x: n.x, y: n.y, z: n.z },
      point: { x: p.x, y: p.y, z: p.z },
    }
  }

  dispose(): void {
    for (const id of [...this.constraints.keys()]) this.removeConstraint(id)
    for (const id of [...this.bodies.keys()]) this.removeBody(id)
    for (const shape of this.sweepShapes.values()) shape.dispose()
    this.sweepShapes.clear()
    if (this.ownsScene) {
      const engine = this.scene.getEngine()
      this.scene.dispose()
      engine.dispose()
    }
  }

  private mustGet(id: BodyId): BodyRecord {
    const rec = this.bodies.get(id)
    if (!rec) throw new Error(`unknown physics body ${id}`)
    return rec
  }

  private makeShape(desc: ShapeDesc): PhysicsShape {
    switch (desc.type) {
      case 'box':
        return new PhysicsShapeBox(
          Vector3.Zero(),
          Quaternion.Identity(),
          new Vector3(desc.size[0], desc.size[1], desc.size[2]),
          this.scene,
        )
      case 'cylinder':
        return new PhysicsShapeCylinder(
          new Vector3(0, -desc.height / 2, 0),
          new Vector3(0, desc.height / 2, 0),
          desc.radius,
          this.scene,
        )
      case 'sphere':
        return new PhysicsShapeSphere(Vector3.Zero(), desc.radius, this.scene)
      case 'capsule': {
        const half = Math.max(desc.height / 2 - desc.radius, 0.01)
        return new PhysicsShapeCapsule(
          new Vector3(0, -half, 0),
          new Vector3(0, half, 0),
          desc.radius,
          this.scene,
        )
      }
      case 'trimesh': {
        // Build a transient mesh purely as the geometry source for the
        // Havok mesh shape; it never renders.
        const mesh = new Mesh(`trimesh-src-${this.nextId}`, this.scene)
        const vd = new VertexData()
        vd.positions = desc.positions
        vd.indices = desc.indices
        vd.applyToMesh(mesh)
        mesh.isVisible = false
        const shape = new PhysicsShapeMesh(mesh, this.scene)
        mesh.dispose()
        return shape
      }
    }
  }

  private getSweepShape(radius: number, height: number, collidesWith: number): PhysicsShapeCapsule {
    const key = `${radius}:${height}:${collidesWith}`
    let shape = this.sweepShapes.get(key)
    if (!shape) {
      const half = Math.max(height / 2 - radius, 0.01)
      shape = new PhysicsShapeCapsule(
        new Vector3(0, -half, 0),
        new Vector3(0, half, 0),
        radius,
        this.scene,
      )
      shape.filterMembershipMask = CollisionLayer.Player
      shape.filterCollideMask = collidesWith
      this.sweepShapes.set(key, shape)
    }
    return shape
  }
}

function toBjs(v: Vec3): Vector3 {
  return new Vector3(v.x, v.y, v.z)
}

/**
 * Perpendicular joint frames that make the bodies' CURRENT pose the joint's
 * zero: perpA is an arbitrary unit vector ⊥ axisA (in A local space) and
 * perpB is its image through the current world alignment, re-orthogonalized
 * against axisB. Without this, hinge/slider limits and motor angles would
 * be measured from an arbitrary datum instead of "where you built it".
 */
function jointFrames(
  axisALocal: Vec3,
  axisBLocal: Vec3,
  recA: BodyRecord,
  recB: BodyRecord,
): { axisA: Vector3; axisB: Vector3; perpA: Vector3; perpB: Vector3 } {
  const axisA = toBjs(axisALocal).normalize()
  const axisB = toBjs(axisBLocal).normalize()
  // Arbitrary but stable perpendicular to axisA.
  const seed = Math.abs(axisA.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
  const perpA = Vector3.Cross(axisA, seed).normalize()
  const rotA = recA.node.rotationQuaternion ?? Quaternion.Identity()
  const rotB = recB.node.rotationQuaternion ?? Quaternion.Identity()
  const worldPerpA = perpA.applyRotationQuaternion(rotA)
  const perpBRaw = worldPerpA.applyRotationQuaternion(rotB.conjugate())
  // Project out any axisB component (axes may not be perfectly aligned in
  // world space when the player links two tilted props).
  const perpB = perpBRaw.subtract(axisB.scale(Vector3.Dot(axisB, perpBRaw)))
  if (perpB.lengthSquared() < 1e-8) {
    const seedB = Math.abs(axisB.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)
    return { axisA, axisB, perpA, perpB: Vector3.Cross(axisB, seedB).normalize() }
  }
  return { axisA, axisB, perpA, perpB: perpB.normalize() }
}

function setupWorld(scene: Scene, havok: unknown, ownsScene: boolean): HavokWorld {
  const plugin = new HavokPlugin(false, havok)
  // Source-engine gravity (sv_gravity 600 ≈ 15.24 m/s²) — real-world 9.81
  // reads floaty at game scale.
  scene.enablePhysics(new Vector3(0, -16.5, 0), plugin)
  // All stepping goes through HavokWorld.step(); never the render loop.
  scene.physicsEnabled = false
  return new HavokWorld(scene, plugin, ownsScene)
}

/** Server-side world: owns a NullEngine scene that is never rendered. */
export function createHeadlessHavokWorld(havok: unknown): HavokWorld {
  const engine = new NullEngine()
  const scene = new Scene(engine)
  return setupWorld(scene, havok, true)
}

/** Client-side world sharing the rendered scene (bodies stay invisible; rendering reads game state, not physics nodes). */
export function createHavokWorldForScene(scene: Scene, havok: unknown): HavokWorld {
  return setupWorld(scene, havok, false)
}
