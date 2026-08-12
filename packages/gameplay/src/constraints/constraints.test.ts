import { describe, expect, it } from 'vitest'
import {
  CONSTRAINT_LIMITS,
  CONSTRAINT_SKILL,
  CONSTRAINT_TYPES,
  validateConstraintParams,
} from './constraints.js'

describe('validateConstraintParams', () => {
  it('accepts a plain weld', () => {
    expect(validateConstraintParams('weld', {}).ok).toBe(true)
  })

  it('rejects non-finite and oversized anchors on every type', () => {
    for (const type of CONSTRAINT_TYPES) {
      expect(
        validateConstraintParams(type, { anchorA: [Number.NaN, 0, 0] }).ok,
        `${type} NaN anchor`,
      ).toBe(false)
      expect(validateConstraintParams(type, { anchorB: [99, 0, 0] }).ok, `${type} far anchor`).toBe(
        false,
      )
    }
  })

  it('validates rope length bounds', () => {
    expect(validateConstraintParams('rope', { length: 2 }).ok).toBe(true)
    expect(validateConstraintParams('rope', { length: 0.05 }).ok).toBe(false)
    expect(validateConstraintParams('rope', { length: 500 }).ok).toBe(false)
    expect(validateConstraintParams('rope', {}).ok).toBe(false)
    expect(validateConstraintParams('rope', { length: Number.POSITIVE_INFINITY }).ok).toBe(false)
  })

  it('validates spring coefficients', () => {
    const good = { length: 1.5, stiffness: 400, damping: 15 }
    expect(validateConstraintParams('spring', good).ok).toBe(true)
    expect(validateConstraintParams('spring', { ...good, stiffness: 1e9 }).ok).toBe(false)
    expect(validateConstraintParams('spring', { ...good, damping: -5 }).ok).toBe(false)
    expect(validateConstraintParams('spring', { ...good, length: 0 }).ok).toBe(false)
  })

  it('requires a usable axis on hinge-family joints', () => {
    for (const type of ['hinge', 'axis', 'slider'] as const) {
      expect(validateConstraintParams(type, {}).ok, `${type} no axis`).toBe(false)
      expect(
        validateConstraintParams(type, { axisA: [0, 0, 0], axisB: [0, 1, 0] }).ok,
        `${type} zero axis`,
      ).toBe(false)
      expect(
        validateConstraintParams(type, { axisA: [0, 1, 0], axisB: [0, 1, 0] }).ok,
        `${type} good axis`,
      ).toBe(true)
    }
  })

  it('validates hinge/slider limits', () => {
    const axes = {
      axisA: [0, 1, 0] as [number, number, number],
      axisB: [0, 1, 0] as [number, number, number],
    }
    expect(validateConstraintParams('hinge', { ...axes, limits: { min: -1, max: 1 } }).ok).toBe(
      true,
    )
    expect(validateConstraintParams('hinge', { ...axes, limits: { min: 1, max: -1 } }).ok).toBe(
      false,
    )
    expect(validateConstraintParams('hinge', { ...axes, limits: { min: -9, max: 9 } }).ok).toBe(
      false,
    )
    expect(validateConstraintParams('slider', { ...axes, limits: { min: -0.5, max: 1 } }).ok).toBe(
      true,
    )
    expect(
      validateConstraintParams('slider', {
        ...axes,
        limits: { min: -CONSTRAINT_LIMITS.slider.maxTravel * 2, max: 1 },
      }).ok,
    ).toBe(false)
  })

  it('requires motor params only on motor joints', () => {
    const axes = {
      axisA: [0, 1, 0] as [number, number, number],
      axisB: [0, 1, 0] as [number, number, number],
    }
    expect(validateConstraintParams('motor', { ...axes }).ok).toBe(false)
    expect(
      validateConstraintParams('motor', {
        ...axes,
        motor: { targetVelocity: 5, maxForce: 300 },
      }).ok,
    ).toBe(true)
    expect(
      validateConstraintParams('motor', {
        ...axes,
        motor: { targetVelocity: 9999, maxForce: 300 },
      }).ok,
    ).toBe(false)
    expect(
      validateConstraintParams('motor', {
        ...axes,
        motor: { targetVelocity: 5, maxForce: -1 },
      }).ok,
    ).toBe(false)
    // A plain hinge may NOT smuggle a motor in.
    expect(
      validateConstraintParams('hinge', {
        ...axes,
        motor: { targetVelocity: 5, maxForce: 300 },
      }).ok,
    ).toBe(false)
  })

  it('gates every type behind a construction level', () => {
    for (const type of CONSTRAINT_TYPES) {
      expect(CONSTRAINT_SKILL[type]).toBeGreaterThanOrEqual(1)
    }
    expect(CONSTRAINT_SKILL.motor).toBeGreaterThan(CONSTRAINT_SKILL.weld)
  })
})
