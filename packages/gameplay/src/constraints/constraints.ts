import type { Result } from '@hobo/shared'
import { err, ok } from '@hobo/shared'

/**
 * Sandbox constraint domain: the player-facing constraint vocabulary and
 * its parameter validation. Engine-free — the server maps these onto
 * physics ConstraintDesc variants; persistence stores them verbatim.
 *
 * 'axis' is a free bearing (hinge without limits); 'motor' is a driven
 * hinge. Both are distinct player-facing types because they read as
 * different tools, but they share the hinge joint underneath.
 */

export const CONSTRAINT_TYPES = [
  'weld',
  'rope',
  'hinge',
  'axis',
  'slider',
  'spring',
  'motor',
] as const

export type ConstraintType = (typeof CONSTRAINT_TYPES)[number]

/** Wire/persistence parameter block. All optional; validation is per-type. */
export interface ConstraintParams {
  /** Anchor in body A/B local space. */
  anchorA?: [number, number, number]
  anchorB?: [number, number, number]
  /** Joint axis in body A/B local space (hinge/axis/slider/motor). */
  axisA?: [number, number, number]
  axisB?: [number, number, number]
  /** Rope length / spring rest length, meters. */
  length?: number
  /** Hinge swing limits (radians) / slider travel limits (meters). */
  limits?: { min: number; max: number }
  /** Spring coefficients. */
  stiffness?: number
  damping?: number
  /** Motor drive (motor type; later machine/vehicle control). */
  motor?: { targetVelocity: number; maxForce: number }
}

/** Hard caps a hostile client can never exceed. */
export const CONSTRAINT_LIMITS = {
  /** Max constraints attached to a single entity. */
  perEntity: 12,
  /** Max distance between the two anchor points at creation. */
  maxGap: 3.5,
  /** Anchor offset from body origin (clamped to plausible prop size). */
  maxAnchorOffset: 3,
  rope: { minLength: 0.3, maxLength: 12 },
  spring: {
    minLength: 0.1,
    maxLength: 8,
    minStiffness: 10,
    maxStiffness: 2000,
    minDamping: 0,
    maxDamping: 200,
  },
  hinge: { maxSwing: Math.PI },
  slider: { maxTravel: 6 },
  motor: { maxVelocity: 20, maxForce: 2000 },
} as const

/** Construction skill level required per constraint type. */
export const CONSTRAINT_SKILL: Record<ConstraintType, number> = {
  weld: 1,
  rope: 1,
  hinge: 2,
  axis: 2,
  slider: 3,
  spring: 4,
  motor: 5,
}

/** Items consumed from the builder's inventory per constraint type. */
export const CONSTRAINT_COST: Partial<Record<ConstraintType, { item: string; count: number }>> = {
  rope: { item: 'rope', count: 1 },
  spring: { item: 'scrap_metal', count: 2 },
  motor: { item: 'salvaged_motor', count: 1 },
}

const vecOk = (v: [number, number, number] | undefined, maxLen: number): boolean =>
  v !== undefined && v.every((n) => Number.isFinite(n)) && Math.hypot(v[0], v[1], v[2]) <= maxLen

const axisOk = (v: [number, number, number] | undefined): boolean =>
  v !== undefined && v.every((n) => Number.isFinite(n)) && Math.hypot(v[0], v[1], v[2]) > 1e-3

/**
 * Semantic validation of a constraint request's parameters. Range/zone/
 * ownership checks live with the server (they need world state); this
 * guards the parameter space itself.
 */
export function validateConstraintParams(
  type: ConstraintType,
  params: ConstraintParams,
): Result<void> {
  const L = CONSTRAINT_LIMITS
  if (!vecOk(params.anchorA ?? [0, 0, 0], L.maxAnchorOffset)) return err('bad_anchor')
  if (!vecOk(params.anchorB ?? [0, 0, 0], L.maxAnchorOffset)) return err('bad_anchor')
  switch (type) {
    case 'weld':
      return ok(undefined)
    case 'rope': {
      const len = params.length ?? 0
      if (!Number.isFinite(len) || len < L.rope.minLength || len > L.rope.maxLength) {
        return err('bad_length')
      }
      return ok(undefined)
    }
    case 'spring': {
      const s = L.spring
      const len = params.length ?? 0
      if (!Number.isFinite(len) || len < s.minLength || len > s.maxLength) return err('bad_length')
      const k = params.stiffness ?? 400
      if (!Number.isFinite(k) || k < s.minStiffness || k > s.maxStiffness) {
        return err('bad_stiffness')
      }
      const d = params.damping ?? 15
      if (!Number.isFinite(d) || d < s.minDamping || d > s.maxDamping) return err('bad_damping')
      return ok(undefined)
    }
    case 'hinge':
    case 'axis':
    case 'slider':
    case 'motor': {
      if (!axisOk(params.axisA) || !axisOk(params.axisB)) return err('bad_axis')
      if (params.limits) {
        const { min, max } = params.limits
        if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return err('bad_limits')
        const span = type === 'slider' ? L.slider.maxTravel : L.hinge.maxSwing
        if (Math.abs(min) > span || Math.abs(max) > span) return err('bad_limits')
      }
      if (type === 'motor') {
        const m = params.motor
        if (
          !m ||
          !Number.isFinite(m.targetVelocity) ||
          !Number.isFinite(m.maxForce) ||
          Math.abs(m.targetVelocity) > L.motor.maxVelocity ||
          m.maxForce <= 0 ||
          m.maxForce > L.motor.maxForce
        ) {
          return err('bad_motor')
        }
      } else if (params.motor) {
        // Only the motor tool creates driven joints.
        return err('bad_motor')
      }
      return ok(undefined)
    }
  }
}
