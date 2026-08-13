import { describe, expect, it } from 'vitest'
import type { CropDef } from '@hobo/content'
import {
  createPlant,
  fertilizePlant,
  harvestPlant,
  isMature,
  migrateLegacyPlant,
  plantProgress,
  plantStage,
  updatePlant,
  waterPlant,
} from './farming.js'

const CROP: CropDef = {
  id: 'test_crop',
  name: 'Test Crop',
  growSeconds: 100,
  stages: 4,
  waterUse: 0.005, // 200s of water in a full tank
  temperature: { min: 5, max: 35 },
  yield: [{ item: 'thing', count: 2 }],
  requiredLevel: 1,
  color: '#00ff00',
}

const DROUGHT_PROOF: CropDef = { ...CROP, id: 'dry', waterUse: 0 }
const REGROWER: CropDef = { ...CROP, id: 're', regrowFraction: 0.4 }

const ctx = (nowMs: number, over: Partial<{ raining: boolean; ambientC: number }> = {}) => ({
  nowMs,
  raining: false,
  ambientC: 20,
  ...over,
})

describe('plant growth', () => {
  it('grows to maturity while watered, lazily from timestamps', () => {
    const p = createPlant('test_crop', 0)
    updatePlant(p, CROP, ctx(50_000))
    expect(plantProgress(p, CROP)).toBeCloseTo(0.5, 3)
    expect(isMature(p, CROP)).toBe(false)
    updatePlant(p, CROP, ctx(100_000))
    expect(isMature(p, CROP)).toBe(true)
    expect(plantStage(p, CROP)).toBe(3)
  })

  it('pauses when the water runs out; watering resumes growth', () => {
    const p = createPlant('test_crop', 0)
    // Full tank = 200s of growth; jump 300s: only 200s accrue.
    updatePlant(p, CROP, ctx(300_000))
    expect(p.progress).toBeCloseTo(100, 0) // capped at growSeconds anyway
    const thirsty = createPlant('test_crop', 0)
    thirsty.water = 0.1 // 20s of water
    updatePlant(thirsty, CROP, ctx(60_000))
    expect(thirsty.progress).toBeCloseTo(20, 1)
    expect(thirsty.water).toBe(0)
    // Parched: no further growth.
    updatePlant(thirsty, CROP, ctx(120_000))
    expect(thirsty.progress).toBeCloseTo(20, 1)
    expect(waterPlant(thirsty)).toBe(true)
    updatePlant(thirsty, CROP, ctx(150_000))
    expect(thirsty.progress).toBeCloseTo(50, 1)
  })

  it('rain keeps the tank full and growth running', () => {
    const p = createPlant('test_crop', 0)
    p.water = 0
    updatePlant(p, CROP, ctx(80_000, { raining: true }))
    expect(p.progress).toBeCloseTo(80, 1)
    expect(p.water).toBe(1)
  })

  it('drought-proof crops ignore water entirely', () => {
    const p = createPlant('dry', 0)
    p.water = 0
    updatePlant(p, DROUGHT_PROOF, ctx(60_000))
    expect(p.progress).toBeCloseTo(60, 1)
  })

  it('pauses outside the temperature band', () => {
    const p = createPlant('test_crop', 0)
    updatePlant(p, CROP, ctx(50_000, { ambientC: -3 }))
    expect(p.progress).toBe(0)
    updatePlant(p, CROP, ctx(100_000, { ambientC: 20 }))
    expect(p.progress).toBeCloseTo(50, 1)
  })

  it('fertilizer boosts growth once', () => {
    const p = createPlant('test_crop', 0)
    expect(fertilizePlant(p, 1.5)).toBe(true)
    expect(fertilizePlant(p, 1.5)).toBe(false)
    updatePlant(p, CROP, ctx(40_000))
    expect(p.progress).toBeCloseTo(60, 1)
  })

  it('regrowing crops reset to their fraction; others clear', () => {
    const p = createPlant('re', 0)
    updatePlant(p, REGROWER, ctx(100_000))
    expect(harvestPlant(p, REGROWER, 100_000)).toBe('regrowing')
    expect(p.progress).toBeCloseTo(40, 1)
    expect(p.boost).toBe(1)
    const single = createPlant('test_crop', 0)
    updatePlant(single, CROP, ctx(100_000))
    expect(harvestPlant(single, CROP, 100_000)).toBe('cleared')
  })

  it('migrates legacy {seedId, plantedAt} plants', () => {
    const migrated = migrateLegacyPlant(
      { seedId: 'berry_seeds', plantedAt: 10_000 },
      (seed) => (seed === 'berry_seeds' ? 'berry' : undefined),
      70_000,
    )
    expect(migrated).toEqual({
      crop: 'berry',
      progress: 60,
      water: 1,
      boost: 1,
      updatedAt: 70_000,
    })
    expect(migrateLegacyPlant({ seedId: 'gone' }, () => undefined, 0)).toBeNull()
  })
})
