import type { GameEntity } from '@hobo/gameplay'
import { CollisionLayer } from '@hobo/physics'
import {
  clamp,
  qfromEuler,
  qfromYaw,
  qmul,
  qnormalize,
  qrotateVec,
  qrotateVecInv,
  qtoEulerYXZ,
  quat,
  v3addScaled,
  v3dist,
  v3sub,
  vec3,
  wrapAngle,
  type Quat,
  type Vec3,
} from '@hobo/shared'
import type { GameWorld } from './gameWorld.js'
import { eyePosition, viewDirection, type PlayerSession } from './playerSession.js'

/**
 * Physgun mechanics, server-authoritative.
 *
 * A grabbed dynamic body is driven toward a target point on the player's
 * view ray using velocity control (not teleportation), so it interacts
 * honestly with the rest of the physics world. Rotation offsets accumulate
 * from client intent commands but are applied here.
 *
 * This module is one *interaction* built on generic pieces (raycast, motion
 * control, zone rules); constraint tools (weld, rope, ...) will be siblings,
 * not extensions of a Physgun class.
 */

export const PHYSGUN_MAX_RANGE = 25
export const PHYSGUN_MIN_DIST = 1
export const PHYSGUN_MAX_DIST = 25
const LINEAR_GAIN = 12
const ANGULAR_GAIN = 8
const MAX_DRIVE_SPEED = 25
const DEFAULT_SNAP_STEP = Math.PI / 12 // 15°

const _eye = vec3()
const _dir = vec3()
const _to = vec3()
const _target = vec3()
const _bodyPos = vec3()
const _bodyRot = quat()
const _vel = vec3()
const _targetRot = quat()
const _yawQ = quat()
const _grabVec = vec3()
const _grabWorld = vec3()
const _euler = { pitch: 0, yaw: 0, roll: 0 }

export type PhysgunDeny = 'no_target' | 'not_allowed' | 'not_owner' | 'zone' | 'already_held'

export function tryGrab(
  session: PlayerSession,
  world: GameWorld,
  heldByOthers: ReadonlySet<string>,
  canManipulate: (entity: GameEntity) => boolean,
): GameEntity | PhysgunDeny {
  eyePosition(session, _eye)
  viewDirection(session, _dir)
  v3addScaled(_to, _eye, _dir, PHYSGUN_MAX_RANGE)
  const hit = world.physics.raycast(_eye, _to, CollisionLayer.Prop)
  if (!hit) return 'no_target'
  const entity = world.entityOfBody(hit.bodyId)
  if (!entity?.prop) return 'no_target'
  if (!world.content.worldRepOf(entity.prop.defId).physgun) return 'not_allowed'
  if (heldByOthers.has(entity.id)) return 'already_held'
  if (!world.zones.rulesAt(entity.transform.pos).physgun) return 'zone'
  if (!canManipulate(entity)) return 'not_owner'

  const bodyId = world.bodyOf(entity.id)
  if (bodyId === undefined) return 'no_target'
  if (entity.prop.motion === 'frozen') {
    world.setPropMotion(entity, 'dynamic')
  }
  world.physics.getTransform(bodyId, _bodyPos, _bodyRot)
  // Grab from the exact hit point: remember it in body-local space so the
  // prop hangs from where the beam touched it.
  v3sub(_grabVec, hit.point, _bodyPos)
  const localOffset = vec3()
  qrotateVecInv(localOffset, _bodyRot, _grabVec)
  // Full orientation relative to view yaw: grabRot = yaw(-viewYaw) * bodyRot.
  // The prop keeps its EXACT pose at grab time (no straightening) and turns
  // with the player's view, like GMod.
  const grabRot = qfromYaw(quat(), -session.yaw)
  qmul(grabRot, grabRot, _bodyRot)
  qnormalize(grabRot, grabRot)
  session.held = {
    entityId: entity.id,
    dist: Math.max(v3dist(_eye, hit.point), PHYSGUN_MIN_DIST),
    localOffset,
    yawOffset: 0,
    pitchOffset: 0,
    snap: false,
    snapStep: DEFAULT_SNAP_STEP,
    grabRot,
    grid: false,
    gridSize: 0.25,
  }
  return entity
}

export function release(session: PlayerSession): void {
  session.held = null
}

export function adjustDistance(session: PlayerSession, delta: number): void {
  if (!session.held) return
  session.held.dist = clamp(session.held.dist + delta, PHYSGUN_MIN_DIST, PHYSGUN_MAX_DIST)
}

export function rotateHeld(
  session: PlayerSession,
  dyaw: number,
  dpitch: number,
  snap: boolean,
  snapStep?: number,
): void {
  const held = session.held
  if (!held) return
  held.yawOffset = wrapAngle(held.yawOffset + dyaw)
  held.pitchOffset = clamp(held.pitchOffset + dpitch, -Math.PI, Math.PI)
  // Snap state is applied to the FULL orientation in driveHeld — offsets
  // always accumulate unsnapped so small mouse deltas never round away.
  held.snap = snap
  held.snapStep = clamp(snapStep ?? DEFAULT_SNAP_STEP, 0.02, 1.6)
}

/** Freezes the held prop in place (motion -> static) and releases the beam. */
export function freezeHeld(session: PlayerSession, world: GameWorld): GameEntity | null {
  const held = session.held
  if (!held) return null
  const entity = world.entities.get(held.entityId)
  if (!entity?.prop) {
    session.held = null
    return null
  }
  const bodyId = world.bodyOf(entity.id)
  if (bodyId !== undefined) {
    world.physics.setLinearVelocity(bodyId, vec3())
    world.physics.setAngularVelocity(bodyId, vec3())
    world.physics.getTransform(bodyId, entity.transform.pos, entity.transform.rot)
  }
  world.setPropMotion(entity, 'frozen')
  session.held = null
  return entity
}

/** Called each tick for sessions holding a prop: drives the body toward the view target. */
export function driveHeld(session: PlayerSession, world: GameWorld): void {
  const held = session.held
  if (!held) return
  const entity = world.entities.get(held.entityId)
  const bodyId = entity?.prop ? world.bodyOf(entity.id) : undefined
  if (!entity || bodyId === undefined || entity.prop?.motion !== 'dynamic') {
    session.held = null
    return
  }

  eyePosition(session, _eye)
  viewDirection(session, _dir)
  v3addScaled(_target, _eye, _dir, held.dist)
  if (held.grid) {
    // Grid-lock: quantize the drive target for tidy construction.
    const g = held.gridSize
    _target.x = Math.round(_target.x / g) * g
    _target.y = Math.round(_target.y / g) * g
    _target.z = Math.round(_target.z / g) * g
  }

  world.physics.getTransform(bodyId, _bodyPos, _bodyRot)
  // Drive the GRAB POINT (not the center) toward the target — the prop
  // hangs from where it was grabbed, exactly like GMod.
  qrotateVec(_grabVec, _bodyRot, held.localOffset)
  _grabWorld.x = _bodyPos.x + _grabVec.x
  _grabWorld.y = _bodyPos.y + _grabVec.y
  _grabWorld.z = _bodyPos.z + _grabVec.z
  v3sub(_vel, _target, _grabWorld)
  _vel.x *= LINEAR_GAIN
  _vel.y *= LINEAR_GAIN
  _vel.z *= LINEAR_GAIN
  const speed = Math.hypot(_vel.x, _vel.y, _vel.z)
  if (speed > MAX_DRIVE_SPEED) {
    const s = MAX_DRIVE_SPEED / speed
    _vel.x *= s
    _vel.y *= s
    _vel.z *= s
  }
  world.physics.wake(bodyId)
  world.physics.setLinearVelocity(bodyId, _vel)

  // Orientation: view yaw + player rotate offsets, on top of the EXACT
  // orientation the prop had at grab time (grabRot).
  qfromYaw(_targetRot, session.yaw + held.yawOffset)
  if (held.pitchOffset !== 0) {
    const half = held.pitchOffset * 0.5
    qmul(_targetRot, _targetRot, quat(Math.sin(half), 0, 0, Math.cos(half)))
  }
  qmul(_targetRot, _targetRot, held.grabRot)
  qnormalize(_targetRot, _targetRot)
  if (held.snap) {
    // Shift+E: snap the WHOLE world orientation to the angle grid — the prop
    // visibly clicks to 0°/15°/30°... regardless of how it was grabbed.
    const s = held.snapStep
    qtoEulerYXZ(_targetRot, _euler)
    qfromEuler(
      _targetRot,
      Math.round(_euler.pitch / s) * s,
      Math.round(_euler.yaw / s) * s,
      Math.round(_euler.roll / s) * s,
    )
  }
  const angVel = angularVelocityToward(_bodyRot, _targetRot, ANGULAR_GAIN)
  world.physics.setAngularVelocity(bodyId, angVel)
}

const _errQ = quat()
const _angOut = vec3()

/** Angular velocity that rotates `from` toward `to` with proportional gain. */
function angularVelocityToward(from: Quat, to: Quat, gain: number): Vec3 {
  // error = to * from^-1 (from is unit: inverse = conjugate)
  _errQ.x = -from.x
  _errQ.y = -from.y
  _errQ.z = -from.z
  _errQ.w = from.w
  qmul(_errQ, to, _errQ)
  qnormalize(_errQ, _errQ)
  let w = clamp(_errQ.w, -1, 1)
  let sx = _errQ.x
  let sy = _errQ.y
  let sz = _errQ.z
  if (w < 0) {
    w = -w
    sx = -sx
    sy = -sy
    sz = -sz
  }
  const angle = 2 * Math.acos(w)
  const sinHalf = Math.sqrt(Math.max(1 - w * w, 0))
  if (sinHalf < 1e-5 || angle < 1e-4) {
    _angOut.x = 0
    _angOut.y = 0
    _angOut.z = 0
    return _angOut
  }
  const scale = (angle * gain) / sinHalf
  _angOut.x = sx * scale
  _angOut.y = sy * scale
  _angOut.z = sz * scale
  return _angOut
}
