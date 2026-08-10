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
  /** Stance: 0 stand, 1 crouch, 2 prone. */
  stance: number
  /** Equipped tool kind for arm posing. */
  tool: 'physgun' | 'axe' | 'pickaxe' | 'hammer' | null
  /** Physgun beam currently latched (two-hand aim pose). */
  beamActive: boolean
}

interface Pose {
  bobRX: number
  bobZ: number
  spineX: number
  spineY: number
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
const WALK_STRIDE = 2.15 // phase radians advanced per meter

/**
 * Per-group smoothing rates (1/s). Slower spine/arms trail the snappier
 * legs, which is what makes the gait read as fluid instead of robotic.
 */
const DAMP: Record<keyof ReturnType<typeof zeroPose>, number> = {
  bobRX: 5,
  bobZ: 5,
  spineX: 7,
  spineY: 6,
  spineZ: 6,
  chestX: 7,
  headX: 10,
  shoulderLX: 9,
  shoulderLZ: 8,
  shoulderRX: 9,
  shoulderRZ: 8,
  elbowLX: 8,
  elbowRX: 8,
  hipLX: 13,
  hipRX: 13,
  kneeLX: 13,
  kneeRX: 13,
  bobY: 12,
}

function zeroPose(): Pose {
  return {
    bobRX: 0,
    bobZ: 0,
    spineX: 0,
    spineY: 0,
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
  /** One-shot hurt flinch timer. */
  private flinchT = 0
  /** Smoothed grounded factor so landings ease instead of snapping. */
  private groundBlend = 1

  constructor(private readonly joints: RigJoints) {}

  triggerSwing(): void {
    this.swingT = 0.38
  }

  triggerFlinch(): void {
    this.flinchT = 0.35
  }

  update(input: AnimatorInput): void {
    const dt = Math.min(input.dt, 0.1)
    const speedNorm = Math.min(input.speed / RUN_SPEED, 1.2)
    this.phase += input.speed * WALK_STRIDE * dt
    if (this.swingT > 0) this.swingT = Math.max(0, this.swingT - dt)
    if (this.flinchT > 0) this.flinchT = Math.max(0, this.flinchT - dt)
    this.groundBlend += ((input.grounded ? 1 : 0) - this.groundBlend) * Math.min(1, dt * 10)

    const target = zeroPose()

    // ── Locomotion (grounded) ────────────────────────────────────────
    const moveAmp = Math.min(speedNorm * 1.6, 1)
    const legSwing = 0.68 * moveAmp
    const armSwing = 0.36 * moveAmp
    const s = Math.sin(this.phase)
    const c = Math.sin(this.phase + Math.PI)
    target.hipLX = s * legSwing
    target.hipRX = c * legSwing
    // Knees: smooth raised-cosine lift (no snap at the extremes).
    const lift = (ph: number) => {
      const w = Math.sin(ph)
      return w > 0 ? w * w : 0
    }
    target.kneeLX = lift(this.phase + Math.PI * 0.65) * legSwing * 1.25
    target.kneeRX = lift(this.phase + Math.PI * 1.65) * legSwing * 1.25
    target.shoulderLX = c * armSwing
    target.shoulderRX = s * armSwing
    // Elbows trail the shoulder swing softly.
    target.elbowLX = -0.28 - (Math.max(0, c) * 0.4 + 0.08) * moveAmp
    target.elbowRX = -0.28 - (Math.max(0, s) * 0.4 + 0.08) * moveAmp
    target.spineX = 0.09 * speedNorm
    // Torso counter-rotates against the hips and sways with the step.
    target.spineY = Math.sin(this.phase) * 0.09 * moveAmp
    target.spineZ = Math.sin(this.phase) * 0.028 * moveAmp
    target.bobY = -0.012 * moveAmp + Math.sin(this.phase * 2 - 0.6) * 0.022 * moveAmp

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

    // ── Stances ──────────────────────────────────────────────────────
    if (input.stance === 1) {
      // Crouch. The pelvis drop MUST equal how much the bent legs shorten,
      // or the feet punch through the floor: thigh 48.7°+knee bend leaves
      // ~0.36 less vertical leg extent, so the hips sink exactly 0.36.
      target.bobY -= 0.36
      target.hipLX = target.hipLX * 0.4 - 1.15
      target.hipRX = target.hipRX * 0.4 - 1.15
      target.kneeLX = target.kneeLX * 0.4 + 1.9
      target.kneeRX = target.kneeRX * 0.4 + 1.9
      target.spineX += 0.38
      target.chestX += 0.1
      // Arms rest on the knees-ish instead of dangling straight down.
      target.shoulderLX = target.shoulderLX * 0.4 - 0.35
      target.shoulderRX = target.shoulderRX * 0.4 - 0.35
      target.elbowLX = -0.5
      target.elbowRX = -0.5
    } else if (input.stance === 2) {
      // Prone: body flat on the ground, legs stretched with toes down,
      // upper body propped slightly on the elbows, head craned up.
      // Army-crawl when moving (limbs alternate with the crawl phase).
      const crawl = Math.min(speedNorm * 4, 1)
      const cs = Math.sin(this.phase) * 0.3 * crawl
      // Babylon is LEFT-handed: POSITIVE X rotation turns the chest
      // skyward (the face-up prone bug) — prone pitches NEGATIVE.
      target.bobRX = -1.42
      // The bob pivot sits at FOOT height; the pelvis rides 0.84 up the
      // rotated axis, so its height is bobY + 0.84*cos(bobRX) ≈ bobY+0.13.
      // bobY must stay ~0 — a negative offset here sinks the whole rotated
      // body underground (the prone-under-the-floor bug, twice).
      target.bobY = 0.04
      // Center the lying body on the collision capsule (fair hitboxes):
      // the torso extends ~0.9 forward of the pivot, so pull back half.
      target.bobZ = -0.45
      // Legs nearly straight along the ground, slight spread via alternate
      // hip angles while crawling.
      target.hipLX = -0.04 + cs
      target.hipRX = -0.04 - cs
      target.kneeLX = 0.08 + Math.max(0, -cs) * 0.7
      target.kneeRX = 0.08 + Math.max(0, cs) * 0.7
      target.shoulderLX = -2.75 - cs * 0.5
      target.shoulderRX = -2.75 + cs * 0.5
      target.shoulderLZ = 0.35
      target.shoulderRZ = -0.35
      target.elbowLX = -0.85
      target.elbowRX = -0.85
      // Chest propped up on the forearms; head looks ahead, not into dirt.
      target.spineX = -0.3
      target.chestX = -0.12
    }

    // ── View pitch aim (body follows the eyes a little) ──────────────
    target.headX = -input.pitch * 0.55 + (input.stance === 2 ? -0.8 : 0)
    target.chestX += input.stance === 2 ? 0 : -input.pitch * 0.22

    // ── Tool poses (upper-body override) ─────────────────────────────
    if (input.stance !== 2 && input.tool === 'physgun') {
      // Forearm ends up ~horizontal (tool aligns with the forearm).
      target.shoulderRX = -0.9 - input.pitch * 0.55
      target.elbowRX = -0.62
      target.shoulderRZ = -0.08
      if (input.beamActive) {
        target.shoulderRX = -1.0 - input.pitch * 0.7
        target.elbowRX = -0.5
        target.shoulderLX = -0.8 - input.pitch * 0.5
        target.elbowLX = -0.65
      }
    } else if (
      input.stance !== 2 &&
      (input.tool === 'axe' || input.tool === 'pickaxe' || input.tool === 'hammer')
    ) {
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
    } else if (input.stance !== 2 && this.swingT > 0) {
      // Bare-hand / held-item punch: a quick straight jab.
      const k = this.swingT / 0.38
      const jab = Math.sin(k * Math.PI)
      target.shoulderRX = -1.15 * jab
      target.elbowRX = -0.9 + jab * 0.85
      target.spineY += jab * 0.18
      target.chestX += jab * 0.08
    }

    // ── Hurt flinch: sharp recoil twist that decays fast ─────────────
    if (this.flinchT > 0) {
      const k = this.flinchT / 0.35
      const snap = Math.sin(k * Math.PI) * k
      target.chestX += snap * 0.5
      target.spineY += snap * 0.35
      target.headX += snap * 0.6
      target.shoulderLZ += snap * 0.45
      target.shoulderRZ -= snap * 0.45
    }

    // ── Exponentially damp live pose toward target (per-group rates) ──
    const p = this.pose
    for (const key of Object.keys(p) as (keyof Pose)[]) {
      const k = 1 - Math.exp(-dt * DAMP[key])
      p[key] += (target[key] - p[key]) * k
    }

    // ── Apply to joints ──────────────────────────────────────────────
    const j = this.joints
    j.bob.position.y = p.bobY
    j.bob.position.z = p.bobZ
    j.bob.rotation.x = p.bobRX
    j.spine.rotation.x = p.spineX
    j.spine.rotation.y = p.spineY
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
