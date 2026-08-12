import { describe, expect, it } from 'vitest'
import {
  activeStatuses,
  applyDamage,
  applyStatus,
  createStats,
  eat,
  hasStatus,
  normalizeStats,
  tickSurvival,
  type SurvivalContext,
} from './survival.js'

/** Comfortable, dry, unheated baseline context. */
const calm = (over: Partial<SurvivalContext> = {}): SurvivalContext => ({
  sprinting: false,
  ambientC: 18,
  wet: false,
  nearHeat: false,
  nowMs: 1_000_000,
  ...over,
})

describe('survival', () => {
  it('drains thirst over time until dehydration kills', () => {
    const s = createStats()
    let died = false
    const ctx = calm()
    for (let i = 0; i < 45 * 60 && !died; i++) {
      ctx.nowMs += 1000
      died = tickSurvival(s, 1, ctx)
    }
    expect(s.thirst).toBe(0)
    expect(s.health).toBe(0)
    expect(died).toBe(true)
  })

  it('eating restores and clamps; a big meal leaves you well fed', () => {
    const s = createStats()
    s.hunger = 90
    eat(s, { hunger: 42, thirst: 18, health: 10 }, 5_000)
    expect(s.hunger).toBe(100)
    expect(hasStatus(s, 'well_fed', 6_000)).toBe(true)
    expect(hasStatus(s, 'well_fed', 5_000 + 121_000)).toBe(false)
  })

  it('damage kills at zero and reports death exactly once', () => {
    const s = createStats()
    expect(applyDamage(s, 60)).toBe(false)
    expect(applyDamage(s, 60)).toBe(true)
    expect(applyDamage(s, 60)).toBe(false)
  })

  it('sprinting drains stamina; resting regenerates', () => {
    const s = createStats()
    const ctx = calm({ sprinting: true })
    for (let i = 0; i < 10; i++) tickSurvival(s, 1, ctx)
    expect(s.stamina).toBeLessThan(50)
    ctx.sprinting = false
    for (let i = 0; i < 10; i++) tickSurvival(s, 1, ctx)
    expect(s.stamina).toBeGreaterThan(80)
  })

  it('cold exposure chills the body, then freezing drains health', () => {
    const s = createStats()
    const ctx = calm({ ambientC: -4 }) // storm night; effective -4
    for (let i = 0; i < 22; i++) {
      ctx.nowMs += 1000
      tickSurvival(s, 1, ctx)
    }
    expect(s.bodyTemp).toBeLessThan(35)
    expect(s.bodyTemp).toBeGreaterThan(33.5)
    expect(hasStatus(s, 'cold', ctx.nowMs)).toBe(true)
    expect(hasStatus(s, 'freezing', ctx.nowMs)).toBe(false)
    const hpAtCold = s.health
    for (let i = 0; i < 60; i++) {
      ctx.nowMs += 1000
      tickSurvival(s, 1, ctx)
    }
    expect(hasStatus(s, 'freezing', ctx.nowMs)).toBe(true)
    expect(s.health).toBeLessThan(hpAtCold)
  })

  it('wetness pushes a merely chilly night below the chill line', () => {
    const dry = createStats()
    const soaked = createStats()
    const dryCtx = calm({ ambientC: 6 }) // clear night: safe while dry
    const wetCtx = calm({ ambientC: 6, wet: true })
    for (let i = 0; i < 120; i++) {
      dryCtx.nowMs += 1000
      wetCtx.nowMs += 1000
      tickSurvival(dry, 1, dryCtx)
      tickSurvival(soaked, 1, wetCtx)
    }
    expect(dry.bodyTemp).toBeCloseTo(37, 1)
    expect(soaked.bodyTemp).toBeLessThan(36)
  })

  it('a campfire holds body temperature through a cold night', () => {
    const s = createStats()
    const ctx = calm({ ambientC: -5, nearHeat: true })
    for (let i = 0; i < 400; i++) {
      ctx.nowMs += 1000
      tickSurvival(s, 1, ctx)
    }
    expect(s.bodyTemp).toBeGreaterThan(36)
    expect(hasStatus(s, 'cold', ctx.nowMs)).toBe(false)
  })

  it('warmth recovers body temperature after exposure', () => {
    const s = createStats()
    s.bodyTemp = 34
    const ctx = calm()
    for (let i = 0; i < 120; i++) {
      ctx.nowMs += 1000
      tickSurvival(s, 1, ctx)
    }
    expect(s.bodyTemp).toBeGreaterThan(36.5)
  })

  it('overheating multiplies thirst drain', () => {
    const cool = createStats()
    const hot = createStats()
    hot.bodyTemp = 40
    const coolCtx = calm()
    const hotCtx = calm({ ambientC: 45 })
    for (let i = 0; i < 60; i++) {
      coolCtx.nowMs += 1000
      hotCtx.nowMs += 1000
      tickSurvival(cool, 1, coolCtx)
      tickSurvival(hot, 1, hotCtx)
    }
    expect(hot.thirst).toBeLessThan(cool.thirst)
  })

  it('bleeding drains health until it expires', () => {
    const s = createStats()
    const ctx = calm()
    applyStatus(s, 'bleeding', 10, ctx.nowMs)
    for (let i = 0; i < 10; i++) {
      ctx.nowMs += 1000
      tickSurvival(s, 1, ctx)
    }
    expect(s.health).toBeLessThan(95)
    const after = s.health
    for (let i = 0; i < 5; i++) {
      ctx.nowMs += 1000
      tickSurvival(s, 1, ctx)
    }
    expect(s.health).toBeGreaterThanOrEqual(after) // expired; regen resumes
  })

  it('activeStatuses prunes expired entries', () => {
    const s = createStats()
    applyStatus(s, 'wet', 10, 0)
    expect(activeStatuses(s, 5_000)).toEqual(['wet'])
    expect(activeStatuses(s, 11_000)).toEqual([])
    expect(s.statuses.wet).toBeUndefined()
  })

  it('normalizes stats from older saves', () => {
    const s = normalizeStats({ health: 80, hunger: 50, thirst: 40, stamina: 90 })
    expect(s.bodyTemp).toBe(37)
    expect(s.statuses).toEqual({})
    expect(s.health).toBe(80)
    expect(normalizeStats(null).health).toBe(100)
  })
})
