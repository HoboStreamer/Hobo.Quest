import { Buttons } from './buttons.js'
import { clamp, v3addScaled, v3copy, v3dot, v3lengthSq, vec3, type Vec3 } from '@hobo/shared'
import type { CollisionQueries, SweepHit } from './collision.js'
import type { MovementParams } from './params.js'

/**
 * Source/Quake-style kinematic character movement with stances.
 *
 * The player is NOT a dynamic rigid body: each fixed tick we integrate an
 * explicit velocity, sweep the player capsule through the collision world,
 * clip velocity against contact planes and slide along them (which is also
 * exactly what makes surf ramps work), with step-up for stairs. This is
 * deliberately deterministic and side-effect free so the same function
 * serves server authority and client prediction.
 *
 * Stances (stand / crouch / prone) change the collision hull, eye height
 * and speed cap. Transitions take real time and are followed by a lockout,
 * so stance spam can't be exploited; growing stances require headroom.
 *
 * Position convention: `pos` is the CAPSULE CENTER. Eye = pos.y + eye offset.
 */

export enum Stance {
  Stand = 0,
  Crouch = 1,
  Prone = 2,
}

/** Hull heights per stance (capsule total height, m). */
export const STANCE_HULL: readonly number[] = [1.8, 1.2, 0.7]
/** Eye offset above the capsule CENTER per stance. */
export const STANCE_EYE: readonly number[] = [0.65, 0.38, 0.14]
/** Ground-speed multiplier per stance. */
export const STANCE_SPEED: readonly number[] = [1, 0.45, 0.22]
/** Transition durations [from][to] in seconds. */
const STANCE_DUR: readonly (readonly number[])[] = [
  [0, 0.25, 0.9],
  [0.25, 0, 0.6],
  [1.0, 0.7, 0],
]
/** Lockout after a completed transition (anti spam/peek abuse). */
const STANCE_COOLDOWN = 0.4

export function hullHeightFor(stance: Stance): number {
  return STANCE_HULL[stance] ?? 1.8
}

export function eyeOffsetFor(stance: Stance): number {
  return STANCE_EYE[stance] ?? 0.65
}

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
  stance: Stance
  /** Prone is a toggle; this latches the key edge. */
  proneHeld: boolean
  proneActive: boolean
  /** Seconds remaining in the current stance transition (anim + lockout). */
  stanceT: number
  /** Total duration of the running transition (for progress reporting). */
  stanceDur: number
  /** Post-transition lockout remaining. */
  stanceCooldown: number
}

export function createMoveState(spawn: Vec3): PlayerMoveState {
  return {
    pos: { ...spawn },
    vel: vec3(),
    grounded: false,
    jumpHeld: false,
    stance: Stance.Stand,
    proneHeld: false,
    proneActive: false,
    stanceT: 0,
    stanceDur: 0,
    stanceCooldown: 0,
  }
}

/** 0..1 progress of the current stance transition (1 = settled). */
export function stanceProgress(state: PlayerMoveState): number {
  if (state.stanceT <= 0 || state.stanceDur <= 0) return 1
  return 1 - state.stanceT / state.stanceDur
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
  hull: number,
): SweepHit | null {
  // Never grounded while moving up fast (start of a jump).
  if (state.vel.y > 1.0) return null
  v3copy(_end, state.pos)
  _end.y -= params.skin + 0.06
  const hit = world.sweepCapsule(state.pos, _end, params.capsuleRadius, hull)
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
 * Source's air accelerate, faithfully: the ADD limit compares against the
 * CAPPED wish speed (that's what makes strafing gain speed sideways), but
 * the acceleration RATE uses the UNCAPPED wish speed. Capping both (the
 * classic porting mistake) makes air control mushy and surfing impossible.
 */
function airAccelerate(
  state: PlayerMoveState,
  wishdir: Vec3,
  wishSpeedFull: number,
  cap: number,
  accel: number,
  dt: number,
): void {
  const wishSpd = Math.min(wishSpeedFull, cap)
  const currentSpeed = v3dot(state.vel, wishdir)
  const addSpeed = wishSpd - currentSpeed
  if (addSpeed <= 0) return
  const accelSpeed = Math.min(accel * wishSpeedFull * dt, addSpeed)
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
  hull: number,
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

    const hit = world.sweepCapsule(state.pos, _end, params.capsuleRadius, hull)
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

    // Depenetration: a sweep blocked at its very start means the capsule is
    // slightly EMBEDDED in geometry (sliding into a corner can shave past
    // the skin). Nudge out along the contact normal — without this the
    // player wedges permanently on box corners.
    if (hit.fraction === 0) {
      v3addScaled(state.pos, state.pos, hit.normal, 0.015)
    }

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
  hull: number,
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
  const upHit = world.sweepCapsule(state.pos, _end, params.capsuleRadius, hull)
  const upFrac = upHit ? Math.max(upHit.fraction - params.skin / params.stepHeight, 0) : 1
  state.pos.y += params.stepHeight * upFrac

  slideMove(state, world, params, hull, dt)

  // Settle back down onto the step surface.
  v3copy(_down, state.pos)
  _down.y -= params.stepHeight * upFrac + params.skin
  const downHit = world.sweepCapsule(state.pos, _down, params.capsuleRadius, hull)
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

/** Stance state machine: desires, timed transitions, headroom, lockout. */
function updateStance(
  state: PlayerMoveState,
  input: MoveInput,
  params: MovementParams,
  world: CollisionQueries,
  dt: number,
): void {
  if (state.stanceT > 0) state.stanceT = Math.max(0, state.stanceT - dt)
  if (state.stanceCooldown > 0) state.stanceCooldown = Math.max(0, state.stanceCooldown - dt)

  // Prone toggles on key edge.
  const proneDown = (input.buttons & Buttons.Prone) !== 0
  if (proneDown && !state.proneHeld) state.proneActive = !state.proneActive
  state.proneHeld = proneDown

  const crouchHeld = (input.buttons & Buttons.Crouch) !== 0
  const desired: Stance = state.proneActive
    ? Stance.Prone
    : crouchHeld
      ? Stance.Crouch
      : Stance.Stand
  if (desired === state.stance || state.stanceT > 0 || state.stanceCooldown > 0) return

  const oldHull = hullHeightFor(state.stance)
  const newHull = hullHeightFor(desired)
  if (newHull > oldHull) {
    // Growing needs headroom: sweep the current hull upward by the delta.
    v3copy(_end, state.pos)
    _end.y += newHull - oldHull + params.skin
    if (world.sweepCapsule(state.pos, _end, params.capsuleRadius, oldHull)) {
      // Blocked — cancel a prone->up desire so it doesn't retry forever
      // against a ceiling (the player can toggle again).
      if (state.stance === Stance.Prone && desired !== Stance.Prone) state.proneActive = true
      return
    }
  }

  // Commit: hull changes now, feet stay planted, timers gate the next change.
  state.pos.y += (newHull - oldHull) / 2
  const dur = STANCE_DUR[state.stance]?.[desired] ?? 0.3
  state.stance = desired
  state.stanceT = dur
  state.stanceDur = dur
  state.stanceCooldown = dur + STANCE_COOLDOWN
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
  updateStance(state, input, params, world, dt)
  const hull = hullHeightFor(state.stance)

  const groundHit = checkGround(state, world, params, hull)
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
  const sprinting = (input.buttons & Buttons.Sprint) !== 0 && state.stance === Stance.Stand
  const maxSpeed =
    (sprinting ? params.maxSprintSpeed : params.maxGroundSpeed) * (STANCE_SPEED[state.stance] ?? 1)
  const wishSpeed = Math.min(wishLen, 1) * maxSpeed

  // Jumping only from a standing, settled stance.
  const wantJump = (input.buttons & Buttons.Jump) !== 0
  const jumpPressed =
    wantJump && (params.autoBhop || !state.jumpHeld) && state.stance === Stance.Stand
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
    // Air control (air-strafing) + gravity: on steep ramps checkGround finds
    // no floor, slideMove clips velocity along the surface — that pair IS
    // surf physics.
    airAccelerate(state, _wishdir, wishSpeed, params.airSpeedCap, params.airAccel, dt)
    state.vel.y -= params.gravity * dt
  }

  v3copy(_stepPos, state.pos)
  const startVel = { x: state.vel.x, y: state.vel.y, z: state.vel.z }
  const blocked = slideMove(state, world, params, hull, dt)
  if (blocked && state.grounded) {
    tryStepMove(state, world, params, hull, dt, _stepPos, startVel)
  }

  // Terminal velocity guard.
  state.vel.y = clamp(state.vel.y, -50, 50)
}
