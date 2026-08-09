import type { GameEntity } from '@hobo/gameplay'
import { CollisionLayer } from '@hobo/physics'
import {
  clamp,
  qfromYaw,
  qmul,
  qnormalize,
  quat,
  v3addScaled,
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

export const PHYSGUN_MAX_RANGE = 8
export const PHYSGUN_MIN_DIST = 1
export const PHYSGUN_MAX_DIST = 10
const LINEAR_GAIN = 12
const ANGULAR_GAIN = 8
const MAX_DRIVE_SPEED = 25
const SNAP_STEP = Math.PI / 12 // 15°

const _eye = vec3()
const _dir = vec3()
const _to = vec3()
const _target = vec3()
const _bodyPos = vec3()
const _bodyRot = quat()
const _vel = vec3()
const _targetRot = quat()
const _yawQ = quat()

export type PhysgunDeny = 'no_target' | 'not_allowed' | 'zone' | 'already_held'

export function tryGrab(
  session: PlayerSession,
  world: GameWorld,
  heldByOthers: ReadonlySet<string>,
  eyeOffset: number,
): GameEntity | PhysgunDeny {
  eyePosition(session, eyeOffset, _eye)
  viewDirection(session, _dir)
  v3addScaled(_to, _eye, _dir, PHYSGUN_MAX_RANGE)
  const hit = world.physics.raycast(_eye, _to, CollisionLayer.Prop)
  if (!hit) return 'no_target'
  const entity = world.entityOfBody(hit.bodyId)
  if (!entity?.prop) return 'no_target'
  const def = world.content.item(entity.prop.defId)
  if (!def?.world?.physgun) return 'not_allowed'
  if (heldByOthers.has(entity.id)) return 'already_held'
  if (!world.zones.rulesAt(entity.transform.pos).physgun) return 'zone'

  const dist = Math.max(hit.fraction * PHYSGUN_MAX_RANGE, PHYSGUN_MIN_DIST)
  // Preserve current orientation relative to the player's view yaw.
  const bodyId = world.bodyOf(entity.id)
  if (bodyId === undefined) return 'no_target'
  if (entity.prop.motion === 'frozen') {
    world.setPropMotion(entity, 'dynamic')
  }
  world.physics.getTransform(bodyId, _bodyPos, _bodyRot)
  session.held = {
    entityId: entity.id,
    dist,
    yawOffset: 0,
    pitchOffset: 0,
    grabYawDelta: extractYaw(_bodyRot) - session.yaw,
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
): void {
  const held = session.held
  if (!held) return
  held.yawOffset = wrapAngle(held.yawOffset + dyaw)
  held.pitchOffset = clamp(held.pitchOffset + dpitch, -Math.PI / 2, Math.PI / 2)
  if (snap) {
    held.yawOffset = Math.round(held.yawOffset / SNAP_STEP) * SNAP_STEP
    held.pitchOffset = Math.round(held.pitchOffset / SNAP_STEP) * SNAP_STEP
  }
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
export function driveHeld(session: PlayerSession, world: GameWorld, eyeOffset: number): void {
  const held = session.held
  if (!held) return
  const entity = world.entities.get(held.entityId)
  const bodyId = entity?.prop ? world.bodyOf(entity.id) : undefined
  if (!entity || bodyId === undefined || entity.prop?.motion !== 'dynamic') {
    session.held = null
    return
  }

  eyePosition(session, eyeOffset, _eye)
  viewDirection(session, _dir)
  v3addScaled(_target, _eye, _dir, held.dist)

  world.physics.getTransform(bodyId, _bodyPos, _bodyRot)
  v3sub(_vel, _target, _bodyPos)
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

  // Orientation: follow player yaw + accumulated offsets.
  const targetYaw = session.yaw + held.grabYawDelta + held.yawOffset
  qfromYaw(_targetRot, targetYaw)
  if (held.pitchOffset !== 0) {
    const half = held.pitchOffset * 0.5
    qmul(_targetRot, _targetRot, quat(Math.sin(half), 0, 0, Math.cos(half)))
  }
  qnormalize(_targetRot, _targetRot)
  const angVel = angularVelocityToward(_bodyRot, _targetRot, ANGULAR_GAIN)
  world.physics.setAngularVelocity(bodyId, angVel)
}

function extractYaw(q: Quat): number {
  // Yaw from quaternion (Y-up).
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x))
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
