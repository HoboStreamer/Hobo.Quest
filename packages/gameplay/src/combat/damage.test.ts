import { describe, expect, it } from 'vitest'
import {
  canFire,
  causesBleeding,
  mitigate,
  recordShot,
  startReload,
  weaponStateFromMeta,
  weaponStateToMeta,
  type RangedWeaponSpec,
} from './damage.js'

const SPEC: RangedWeaponSpec = {
  damage: 20,
  range: 40,
  fireIntervalMs: 500,
  spreadDeg: 2,
  ammoItem: 'pistol_round',
  magazine: 8,
  reloadMs: 1800,
}

describe('damage mitigation', () => {
  it('armor reduces mitigable damage', () => {
    expect(mitigate({ type: 'projectile', amount: 20 }, { reduction: 0.4 })).toBeCloseTo(12)
    expect(mitigate({ type: 'blunt', amount: 10 }, null)).toBe(10)
  })

  it('fall and environment damage ignore armor', () => {
    expect(mitigate({ type: 'fall', amount: 30 }, { reduction: 0.9 })).toBe(30)
    expect(mitigate({ type: 'environment', amount: 5 }, { reduction: 0.5 })).toBe(5)
  })

  it('clamps hostile armor values', () => {
    expect(mitigate({ type: 'projectile', amount: 100 }, { reduction: 5 })).toBeCloseTo(10)
    expect(mitigate({ type: 'projectile', amount: 100 }, { reduction: -3 })).toBe(100)
  })

  it('big cutting/projectile wounds bleed; blunt never does', () => {
    expect(causesBleeding('cutting', 14)).toBe(true)
    expect(causesBleeding('projectile', 12)).toBe(true)
    expect(causesBleeding('cutting', 6)).toBe(false)
    expect(causesBleeding('blunt', 50)).toBe(false)
  })
})

describe('fire control', () => {
  it('enforces magazine, cadence and reload state', () => {
    const s = { mag: 2, lastFireMs: 0, reloadUntil: 0 }
    expect(canFire(s, SPEC, 1000)).toBe('ok')
    recordShot(s, 1000)
    expect(s.mag).toBe(1)
    expect(canFire(s, SPEC, 1200)).toBe('too_fast')
    expect(canFire(s, SPEC, 1460)).toBe('ok') // 10% slack
    recordShot(s, 1500)
    expect(canFire(s, SPEC, 2100)).toBe('empty')
  })

  it('reload takes only what is available and blocks firing meanwhile', () => {
    const s = { mag: 1, lastFireMs: 0, reloadUntil: 0 }
    expect(startReload(s, SPEC, 3, 5000)).toBe(3)
    expect(s.mag).toBe(4)
    expect(s.reloadUntil).toBe(6800)
    expect(canFire(s, SPEC, 6000)).toBe('reloading')
    expect(canFire(s, SPEC, 6900)).toBe('ok')
    // Already reloading: no double-take.
    s.reloadUntil = 99_000
    expect(startReload(s, SPEC, 10, 7000)).toBe(0)
    // Full mag: nothing to do.
    const full = { mag: 8, lastFireMs: 0, reloadUntil: 0 }
    expect(startReload(full, SPEC, 10, 0)).toBe(0)
  })

  it('round-trips weapon state through stack meta', () => {
    const s = { mag: 5, lastFireMs: 123, reloadUntil: 456 }
    const meta = weaponStateToMeta(s, { dur: 10 })
    expect(meta).toEqual({ dur: 10, mag: 5, lastFireMs: 123, reloadUntil: 456 })
    expect(weaponStateFromMeta(meta)).toEqual(s)
    expect(weaponStateFromMeta(undefined)).toEqual({ mag: 0, lastFireMs: 0, reloadUntil: 0 })
  })
})
