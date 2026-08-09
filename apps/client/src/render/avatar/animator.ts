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
  /** Equipped tool kind for arm posing. */
  tool: 'physgun' | 'axe' | 'pickaxe' | 'hammer' | null
  /** Physgun beam currently latched (two-hand aim pose). */
  beamActive: boolean
}

interface Pose {
  spineX: number
  spineZ: number
  chestX: number
  headX: number
  shoulderLX: number
  shoulderLZ: number
  shoulderRX: number
  shoulderRZ: number
  elbowLX: number
  elbowRX: number
  hipLX: number
  hipRX: number
  kneeLX: number
  kneeRX: number
  bobY: number
}

const RUN_SPEED = 7.2
const WALK_STRIDE = 2.4 // phase radians advanced per meter

function zeroPose(): Pose {
  return {
    spineX: 0,
    spineZ: 0,
    chestX: 0,
    headX: 0,
    shoulderLX: 0,
    shoulderLZ: 0,
    shoulderRX: 0,
    shoulderRZ: 0,
    elbowLX: 0,
    elbowRX: 0,
    hipLX: 0,
    hipRX: 0,
    kneeLX: 0,
    kneeRX: 0,
    bobY: 0,
  }
}

export class AvatarAnimator {
  private phase = 0
  private pose = zeroPose()
  /** One-shot swing timer (s remaining); drives axe/pickaxe chop. */
  private swingT = 0
  /** Smoothed grounded factor so landings ease instead of snapping. */
  private groundBlend = 1

  constructor(private readonly joints: RigJoints) {}

  triggerSwing(): void {
    this.swingT = 0.38
  }

  update(input: AnimatorInput): void {
    const dt = Math.min(input.dt, 0.1)
    const speedNorm = Math.min(input.speed / RUN_SPEED, 1.2)
    this.phase += input.speed * WALK_STRIDE * dt
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt)
    this.groundBlend += ((input.grounded ? 1 : 0) - this.groundBlend) * Math.min(1, dt * 10)

    const target = zeroPose()

    // ── Locomotion (grounded) ────────────────────────────────────────
    const moveAmp = Math.min(speedNorm * 1.6, 1)
    const legSwing = 0.75 * moveAmp
    const armSwing = 0.45 * moveAmp
    const s = Math.sin(this.phase)
    const c = Math.sin(this.phase + Math.PI)
    target.hipLX = s * legSwing
    target.hipRX = c * legSwing
    // Knees bend on the back/lift part of the cycle.
    target.kneeLX = Math.max(0, Math.sin(this.phase + Math.PI * 0.72)) * legSwing * 1.15
    target.kneeRX = Math.max(0, Math.sin(this.phase + Math.PI * 1.72)) * legSwing * 1.15
    target.shoulderLX = c * armSwing
    target.shoulderRX = s * armSwing
    target.elbowLX = -0.25 - Math.max(0, c) * 0.5 * moveAmp
    target.elbowRX = -0.25 - Math.max(0, s) * 0.5 * moveAmp
    target.spineX = 0.1 * speedNorm
    target.bobY = Math.abs(Math.sin(this.phase)) * 0.035 * moveAmp - 0.015 * moveAmp
    target.spineZ = Math.sin(this.phase) * 0.03 * moveAmp

    // ── Idle overlay when still ──────────────────────────────────────
    if (speedNorm < 0.05) {
      const breathe = Math.sin(input.time * 1.7)
      target.chestX = breathe * 0.02
      target.shoulderLZ = 0.06 + breathe * 0.01
      target.shoulderRZ = -0.06 - breathe * 0.01
      target.elbowLX = -0.12
      target.elbowRX = -0.12
      target.bobY = breathe * 0.004
    }

    // ── Airborne ─────────────────────────────────────────────────────
    const air = 1 - this.groundBlend
    if (air > 0.01) {
      target.hipLX = target.hipLX * this.groundBlend + -0.45 * air
      target.hipRX = target.hipRX * this.groundBlend + -0.2 * air
      target.kneeLX = target.kneeLX * this.groundBlend + 0.8 * air
      target.kneeRX = target.kneeRX * this.groundBlend + 0.55 * air
      target.shoulderLZ += 0.5 * air
      target.shoulderRZ += -0.5 * air
      target.spineX += 0.08 * air
    }

    // ── View pitch aim (body follows the eyes a little) ──────────────
    target.headX = -input.pitch * 0.55
    target.chestX += -input.pitch * 0.22

    // ── Tool poses (upper-body override) ─────────────────────────────
    if (input.tool === 'physgun') {
      const aim = input.beamActive ? 1 : 0.75
      target.shoulderRX = (-1.05 - input.pitch * 0.7) * aim
      target.elbowRX = -0.35
      target.shoulderRZ = -0.06
      if (input.beamActive) {
        target.shoulderLX = -0.75 - input.pitch * 0.5
        target.elbowLX = -0.7
      }
    } else if (input.tool === 'axe' || input.tool === 'pickaxe' || input.tool === 'hammer') {
      // Relaxed carry; chop when swinging.
      target.shoulderRX = -0.35
      target.elbowRX = -0.75
      if (this.swingT > 0) {
        const k = this.swingT / 0.38 // 1 -> 0
        const raise = Math.sin(k * Math.PI) // up then down
        target.shoulderRX = -0.35 - raise * 1.35
        target.elbowRX = -0.75 + raise * 0.35
        target.chestX += raise * 0.12
      }
    }

    // ── Exponentially damp live pose toward target ───────────────────
    const k = 1 - Math.exp(-dt * 14)
    const p = this.pose
    for (const key of Object.keys(p) as (keyof Pose)[]) {
      p[key] += (target[key] - p[key]) * k
    }

    // ── Apply to joints ──────────────────────────────────────────────
    const j = this.joints
    j.bob.position.y = p.bobY
    j.spine.rotation.x = p.spineX
    j.spine.rotation.z = p.spineZ
    j.chest.rotation.x = p.chestX
    j.head.rotation.x = p.headX
    j.shoulderL.rotation.x = p.shoulderLX
    j.shoulderL.rotation.z = p.shoulderLZ
    j.shoulderR.rotation.x = p.shoulderRX
    j.shoulderR.rotation.z = p.shoulderRZ
    j.elbowL.rotation.x = p.elbowLX
    j.elbowR.rotation.x = p.elbowRX
    j.hipL.rotation.x = p.hipLX
    j.hipR.rotation.x = p.hipRX
    j.kneeL.rotation.x = p.kneeLX
    j.kneeR.rotation.x = p.kneeRX
  }
}
