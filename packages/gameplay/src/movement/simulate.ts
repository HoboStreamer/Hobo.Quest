import { Buttons } from './buttons.js'
import { clamp, v3addScaled, v3copy, v3dot, v3lengthSq, vec3, type Vec3 } from '@hobo/shared'
import type { CollisionQueries, SweepHit } from './collision.js'
import type { MovementParams } from './params.js'

/**
 * Source/Quake-style kinematic character movement.
 *
 * The player is NOT a dynamic rigid body: each fixed tick we integrate an
 * explicit velocity, sweep the player capsule through the collision world,
 * clip velocity against contact planes and slide along them, with step-up
 * for stairs/ledges. This is deliberately deterministic and side-effect
 * free so the same function serves server authority and client prediction.
 *
 * Position convention: `pos` is the CAPSULE CENTER. Eye = pos.y + eyeOffset.
 */

export interface MoveInput {
  /** Strafe axis [-1,1], +X right. */
  moveX: number
  /** Forward axis [-1,1], +Z forward. */
  moveZ: number
  yaw: number
  pitch: number
  buttons: number
}

export interface PlayerMoveState {
  pos: Vec3
  vel: Vec3
  grounded: boolean
  /** Edge detection for non-autobhop jumping. */
  jumpHeld: boolean
}

export function createMoveState(spawn: Vec3): PlayerMoveState {
  return {
    pos: { ...spawn },
    vel: vec3(),
    grounded: false,
    jumpHeld: false,
  }
}

const MAX_CLIP_PLANES = 5
const MAX_BUMPS = 4
const OVERCLIP = 1.001

// Scratch vectors — module-level to avoid per-tick allocation. Movement is
// single-threaded on both sides; do not call stepMovement re-entrantly.
const _wishdir = vec3()
const _horizVel = vec3()
const _end = vec3()
const _delta = vec3()
const _planes: Vec3[] = Array.from({ length: MAX_CLIP_PLANES }, () => vec3())
const _stepPos = vec3()
const _down = vec3()

/** Removes the component of `vel` going into `normal` (slide along plane). */
export function clipVelocity(vel: Vec3, normal: Vec3, overbounce: number): void {
  const backoff = v3dot(vel, normal) * overbounce
  vel.x -= normal.x * backoff
  vel.y -= normal.y * backoff
  vel.z -= normal.z * backoff
}

function checkGround(
  state: PlayerMoveState,
  world: CollisionQueries,
  params: MovementParams,
): SweepHit | null {
  // Never grounded while moving up fast (start of a jump).
  if (state.vel.y > 1.0) return null
  v3copy(_end, state.pos)
  _end.y -= params.skin + 0.06
  const hit = world.sweepCapsule(state.pos, _end, params.capsuleRadius, params.capsuleHeight)
  if (hit && hit.normal.y >= params.groundNormalY) return hit
  return null
}

function applyFriction(state: PlayerMoveState, params: MovementParams, dt: number): void {
  _horizVel.x = state.vel.x
  _horizVel.y = 0
  _horizVel.z = state.vel.z
  const speed = Math.sqrt(v3lengthSq(_horizVel))
  if (speed < 1e-4) {
    state.vel.x = 0
    state.vel.z = 0
    return
  }
  const control = Math.max(speed, params.stopSpeed)
  const drop = control * params.friction * dt
  const newSpeed = Math.max(speed - drop, 0) / speed
  state.vel.x *= newSpeed
  state.vel.z *= newSpeed
}

function accelerate(
  state: PlayerMoveState,
  wishdir: Vec3,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const currentSpeed = v3dot(state.vel, wishdir)
  const addSpeed = wishSpeed - currentSpeed
  if (addSpeed <= 0) return
  const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed)
  v3addScaled(state.vel, state.vel, wishdir, accelSpeed)
}

/**
 * Sweep-and-slide with clip planes (Quake's SlideMove). Mutates pos/vel.
 * Returns true if movement was blocked by a wall-like plane this tick.
 */
function slideMove(
  state: PlayerMoveState,
  world: CollisionQueries,
  params: MovementParams,
  dt: number,
): boolean {
  let timeLeft = dt
  let planeCount = 0
  let blocked = false

  for (let bump = 0; bump < MAX_BUMPS; bump++) {
    _delta.x = state.vel.x * timeLeft
    _delta.y = state.vel.y * timeLeft
    _delta.z = state.vel.z * timeLeft
    if (v3lengthSq(_delta) < 1e-12) break

    _end.x = state.pos.x + _delta.x
    _end.y = state.pos.y + _delta.y
    _end.z = state.pos.z + _delta.z

    const hit = world.sweepCapsule(state.pos, _end, params.capsuleRadius, params.capsuleHeight)
    if (!hit) {
      v3copy(state.pos, _end)
      break
    }

    // Advance to just before the contact.
    const dist = Math.sqrt(v3lengthSq(_delta))
    const pullback = dist > 1e-8 ? Math.min(params.skin / dist, hit.fraction) : 0
    const moveFrac = Math.max(hit.fraction - pullback, 0)
    v3addScaled(state.pos, state.pos, _delta, moveFrac)
    timeLeft *= 1 - hit.fraction

    if (hit.normal.y < params.groundNormalY && hit.normal.y > -0.1) blocked = true

    if (planeCount >= MAX_CLIP_PLANES) {
      state.vel.x = 0
      state.vel.y = 0
      state.vel.z = 0
      break
    }
    v3copy(_planes[planeCount] as Vec3, hit.normal)
    planeCount++

    // Clip velocity to all accumulated planes; handle crease/corner cases.
    let i = 0
    for (; i < planeCount; i++) {
      const plane = _planes[i] as Vec3
      if (v3dot(state.vel, plane) < 0) clipVelocity(state.vel, plane, OVERCLIP)
    }
    // If still moving into any plane, project onto the crease of two planes.
    for (i = 0; i < planeCount; i++) {
      const plane = _planes[i] as Vec3
      if (v3dot(state.vel, plane) < -1e-6) {
        if (planeCount >= 2) {
          state.vel.x = 0
          state.vel.y = 0
          state.vel.z = 0
        }
        break
      }
    }
    if (timeLeft <= 0) break
  }
  return blocked
}

/**
 * Attempts the classic step move: up, across, down. Used when a slide was
 * blocked by a wall while grounded — lets the player walk up stairs and
 * small ledges without jumping.
 */
function tryStepMove(
  state: PlayerMoveState,
  world: CollisionQueries,
  params: MovementParams,
  dt: number,
  startPos: Vec3,
  startVel: Vec3,
): void {
  const slidPos = { ...state.pos }
  const slidVel = { ...state.vel }

  // Restart from pre-slide state, raised by stepHeight (if headroom allows).
  v3copy(state.pos, startPos)
  v3copy(state.vel, startVel)
  v3copy(_end, state.pos)
  _end.y += params.stepHeight
  const upHit = world.sweepCapsule(state.pos, _end, params.capsuleRadius, params.capsuleHeight)
  const upFrac = upHit ? Math.max(upHit.fraction - params.skin / params.stepHeight, 0) : 1
  state.pos.y += params.stepHeight * upFrac

  slideMove(state, world, params, dt)

  // Settle back down onto the step surface.
  v3copy(_down, state.pos)
  _down.y -= params.stepHeight * upFrac + params.skin
  const downHit = world.sweepCapsule(state.pos, _down, params.capsuleRadius, params.capsuleHeight)
  if (downHit) {
    v3addScaled(state.pos, state.pos, { x: 0, y: _down.y - state.pos.y, z: 0 }, downHit.fraction)
    state.pos.y += params.skin
    if (downHit.normal.y < params.groundNormalY) {
      // Stepped onto a non-walkable surface — keep the plain slide result.
      v3copy(state.pos, slidPos)
      v3copy(state.vel, slidVel)
      return
    }
  } else {
    v3copy(state.pos, _down)
    state.pos.y += params.skin
  }

  // Keep whichever attempt made more horizontal progress.
  const dxS = slidPos.x - startPos.x
  const dzS = slidPos.z - startPos.z
  const dxT = state.pos.x - startPos.x
  const dzT = state.pos.z - startPos.z
  if (dxS * dxS + dzS * dzS > dxT * dxT + dzT * dzT) {
    v3copy(state.pos, slidPos)
    v3copy(state.vel, slidVel)
  } else {
    // Step succeeded: preserve horizontal velocity, kill downward pop.
    state.vel.y = slidVel.y < 0 ? 0 : slidVel.y
  }
}

/**
 * Advances one fixed tick. Deterministic: same state + input + world =>
 * same result, on server and predicting client alike.
 */
export function stepMovement(
  state: PlayerMoveState,
  input: MoveInput,
  params: MovementParams,
  world: CollisionQueries,
  dt: number,
): void {
  const groundHit = checkGround(state, world, params)
  state.grounded = groundHit !== null

  // Wish direction from yaw + move axes (horizontal only).
  const sy = Math.sin(input.yaw)
  const cy = Math.cos(input.yaw)
  const mx = clamp(input.moveX, -1, 1)
  const mz = clamp(input.moveZ, -1, 1)
  _wishdir.x = cy * mx + sy * mz
  _wishdir.y = 0
  _wishdir.z = -sy * mx + cy * mz
  const wishLen = Math.sqrt(v3lengthSq(_wishdir))
  if (wishLen > 1e-6) {
    _wishdir.x /= wishLen
    _wishdir.z /= wishLen
  }
  const sprinting = (input.buttons & Buttons.Sprint) !== 0
  const maxSpeed = sprinting ? params.maxSprintSpeed : params.maxGroundSpeed
  const wishSpeed = Math.min(wishLen, 1) * maxSpeed

  const wantJump = (input.buttons & Buttons.Jump) !== 0
  const jumpPressed = wantJump && (params.autoBhop || !state.jumpHeld)

  if (state.grounded && jumpPressed) {
    state.vel.y = params.jumpSpeed
    state.grounded = false
  }
  state.jumpHeld = wantJump

  if (state.grounded) {
    applyFriction(state, params, dt)
    accelerate(state, _wishdir, wishSpeed, params.groundAccel, dt)
    // Project velocity onto the ground plane so slopes don't launch us.
    if (groundHit && groundHit.normal.y < 0.999) {
      clipVelocity(state.vel, groundHit.normal, 1.0)
    }
    state.vel.y = Math.min(state.vel.y, 0.1)
  } else {
    accelerate(state, _wishdir, Math.min(wishSpeed, params.airSpeedCap), params.airAccel, dt)
    state.vel.y -= params.gravity * dt
  }

  v3copy(_stepPos, state.pos)
  const startVel = { x: state.vel.x, y: state.vel.y, z: state.vel.z }
  const blocked = slideMove(state, world, params, dt)
  if (blocked && state.grounded) {
    tryStepMove(state, world, params, dt, _stepPos, startVel)
  }

  // Terminal velocity guard.
  state.vel.y = clamp(state.vel.y, -50, 50)
}
