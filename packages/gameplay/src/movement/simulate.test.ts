import { describe, expect, it } from 'vitest'
import { vec3, type Vec3 } from '@hobo/shared'
import { Buttons } from './buttons.js'
import type { CollisionQueries, SweepHit } from './collision.js'
import { DEFAULT_MOVEMENT } from './params.js'
import { clipVelocity, createMoveState, stepMovement, type MoveInput } from './simulate.js'

const P = DEFAULT_MOVEMENT
const DT = 1 / 30

/**
 * Analytic test world: infinite ground plane at y=0 and an optional wall
 * plane at x = wallX (normal -X). Capsule contact analytically resolved.
 */
function makeWorld(wallX?: number): CollisionQueries {
  return {
    sweepCapsule(from: Vec3, to: Vec3, radius: number, height: number): SweepHit | null {
      const half = height / 2
      const hits: SweepHit[] = []
      const fromBottom = from.y - half
      const toBottom = to.y - half
      if (fromBottom >= 0 && toBottom < 0) {
        const fraction = fromBottom / (fromBottom - toBottom)
        hits.push({ fraction, normal: vec3(0, 1, 0), point: vec3(from.x, 0, from.z) })
      }
      if (wallX !== undefined) {
        const limit = wallX - radius
        if (from.x <= limit && to.x > limit) {
          const fraction = (limit - from.x) / (to.x - from.x)
          hits.push({ fraction, normal: vec3(-1, 0, 0), point: vec3(wallX, from.y, from.z) })
        }
      }
      if (hits.length === 0) return null
      hits.sort((a, b) => a.fraction - b.fraction)
      return hits[0] ?? null
    },
  }
}

function idle(): MoveInput {
  return { moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 }
}

function forward(buttons = 0): MoveInput {
  return { moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons }
}

function spawnGrounded() {
  return createMoveState(vec3(0, P.capsuleHeight / 2, 0))
}

function horizSpeed(v: Vec3): number {
  return Math.hypot(v.x, v.z)
}

describe('clipVelocity', () => {
  it('removes the into-plane component and keeps tangent motion', () => {
    const v = vec3(3, -4, 0)
    clipVelocity(v, vec3(0, 1, 0), 1.0)
    expect(v.x).toBeCloseTo(3)
    expect(v.y).toBeCloseTo(0)
  })
})

describe('stepMovement', () => {
  it('detects ground at spawn', () => {
    const s = spawnGrounded()
    stepMovement(s, idle(), P, makeWorld(), DT)
    expect(s.grounded).toBe(true)
    expect(s.pos.y).toBeCloseTo(P.capsuleHeight / 2, 1)
  })

  it('accelerates to max ground speed and no further', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 90; i++) stepMovement(s, forward(), P, makeWorld(), DT)
    expect(horizSpeed(s.vel)).toBeGreaterThan(P.maxGroundSpeed * 0.95)
    expect(horizSpeed(s.vel)).toBeLessThan(P.maxGroundSpeed * 1.05)
    // moves in +Z with yaw 0
    expect(s.pos.z).toBeGreaterThan(5)
    expect(Math.abs(s.pos.x)).toBeLessThan(0.01)
  })

  it('sprint raises the speed cap', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 90; i++) stepMovement(s, forward(Buttons.Sprint), P, makeWorld(), DT)
    expect(horizSpeed(s.vel)).toBeGreaterThan(P.maxGroundSpeed)
  })

  it('friction stops the player quickly', () => {
    const s = spawnGrounded()
    for (let i = 0; i < 60; i++) stepMovement(s, forward(), P, makeWorld(), DT)
    for (let i = 0; i < 30; i++) stepMovement(s, idle(), P, makeWorld(), DT)
    expect(horizSpeed(s.vel)).toBeLessThan(0.2)
  })

  it('jumps to roughly v^2/2g and lands grounded', () => {
    const s = spawnGrounded()
    stepMovement(s, idle(), P, makeWorld(), DT) // settle grounded flag
    let apex = 0
    let landedTick = -1
    for (let i = 0; i < 90; i++) {
      const input = i === 0 ? { ...idle(), buttons: Buttons.Jump } : idle()
      stepMovement(s, input, P, makeWorld(), DT)
      apex = Math.max(apex, s.pos.y - P.capsuleHeight / 2)
      if (i > 5 && s.grounded && landedTick < 0) landedTick = i
    }
    const expected = (P.jumpSpeed * P.jumpSpeed) / (2 * P.gravity)
    expect(apex).toBeGreaterThan(expected * 0.85)
    expect(apex).toBeLessThan(expected * 1.25)
    expect(landedTick).toBeGreaterThan(0)
    expect(s.grounded).toBe(true)
    expect(s.pos.y).toBeCloseTo(P.capsuleHeight / 2, 1)
  })

  it('caps forward air acceleration at airSpeedCap', () => {
    const s = spawnGrounded()
    stepMovement(s, idle(), P, makeWorld(), DT)
    stepMovement(s, { ...idle(), buttons: Buttons.Jump }, P, makeWorld(), DT)
    let maxAirSpeed = 0
    for (let i = 0; i < 30; i++) {
      stepMovement(s, forward(), P, makeWorld(), DT)
      if (s.grounded) break
      maxAirSpeed = Math.max(maxAirSpeed, horizSpeed(s.vel))
    }
    expect(maxAirSpeed).toBeGreaterThan(0)
    expect(maxAirSpeed).toBeLessThanOrEqual(P.airSpeedCap * 1.05)
  })

  it('slides along walls instead of stopping', () => {
    const s = spawnGrounded()
    const world = makeWorld(2)
    // Move diagonally (+X into wall, +Z along it)
    const input: MoveInput = { moveX: 1, moveZ: 1, yaw: 0, pitch: 0, buttons: 0 }
    for (let i = 0; i < 120; i++) stepMovement(s, input, P, world, DT)
    expect(s.pos.x).toBeLessThanOrEqual(2 - P.capsuleRadius + 0.01)
    expect(s.pos.z).toBeGreaterThan(4)
  })

  it('is deterministic for identical input streams', () => {
    const run = () => {
      const s = spawnGrounded()
      const world = makeWorld(3)
      for (let i = 0; i < 200; i++) {
        const input: MoveInput = {
          moveX: Math.sin(i * 0.1),
          moveZ: 1,
          yaw: i * 0.01,
          pitch: 0,
          buttons: i % 40 === 0 ? Buttons.Jump : 0,
        }
        stepMovement(s, input, P, world, DT)
      }
      return s
    }
    const a = run()
    const b = run()
    expect(a.pos).toEqual(b.pos)
    expect(a.vel).toEqual(b.vel)
  })
})
