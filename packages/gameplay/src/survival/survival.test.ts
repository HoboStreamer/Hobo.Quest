import { describe, expect, it } from 'vitest'
import { applyDamage, createStats, eat, tickSurvival } from './survival.js'

describe('survival', () => {
  it('drains thirst over time until dehydration kills', () => {
    const s = createStats()
    let died = false
    for (let i = 0; i < 45 * 60 && !died; i++) died = tickSurvival(s, 1, false)
    expect(s.thirst).toBe(0)
    expect(s.health).toBe(0)
    expect(died).toBe(true)
  })

  it('eating restores and clamps', () => {
    const s = createStats()
    s.hunger = 90
    eat(s, { hunger: 42, thirst: 18, health: 10 })
    expect(s.hunger).toBe(100)
  })

  it('damage kills at zero and reports death exactly once', () => {
    const s = createStats()
    expect(applyDamage(s, 60)).toBe(false)
    expect(applyDamage(s, 60)).toBe(true)
    expect(applyDamage(s, 60)).toBe(false)
  })

  it('sprinting drains stamina; resting regenerates', () => {
    const s = createStats()
    for (let i = 0; i < 10; i++) tickSurvival(s, 1, true)
    expect(s.stamina).toBeLessThan(50)
    for (let i = 0; i < 10; i++) tickSurvival(s, 1, false)
    expect(s.stamina).toBeGreaterThan(80)
  })
})
