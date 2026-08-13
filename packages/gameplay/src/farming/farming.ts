import type { CropDef } from '@hobo/content'

/**
 * Plant growth domain: pure, timestamp-lazy state transitions. Plants
 * NEVER tick — progression is computed in closed form whenever something
 * touches the plant (interaction, replication, a slow sweep), so a field
 * of a thousand crops costs nothing between touches.
 */

export interface PlantState {
  /** Crop content id. */
  crop: string
  /** Accumulated effective growth, seconds. */
  progress: number
  /** Plant water tank 0..1 (rain keeps it full; cans/sprinklers refill). */
  water: number
  /** Growth multiplier (fertilizer). 1 = none. */
  boost: number
  /** Timestamp of the last lazy update (epoch ms). */
  updatedAt: number
}

export interface PlantContext {
  nowMs: number
  raining: boolean
  ambientC: number
}

export function createPlant(cropId: string, nowMs: number): PlantState {
  return { crop: cropId, progress: 0, water: 1, boost: 1, updatedAt: nowMs }
}

/**
 * Advances the plant to `nowMs` in closed form. Growth accrues while the
 * plant has water (rain keeps it topped up) and the ambient temperature is
 * inside the crop's band — a mild approximation: conditions AT THE TOUCH
 * apply to the whole interval, which is fine at sweep cadence.
 */
export function updatePlant(plant: PlantState, crop: CropDef, ctx: PlantContext): void {
  const elapsed = (ctx.nowMs - plant.updatedAt) / 1000
  if (elapsed <= 0) return
  plant.updatedAt = ctx.nowMs
  const tempOk = ctx.ambientC >= crop.temperature.min && ctx.ambientC <= crop.temperature.max
  let growSeconds = 0
  if (ctx.raining) {
    plant.water = 1
    growSeconds = elapsed
  } else if (crop.waterUse <= 0) {
    growSeconds = elapsed
  } else {
    const wateredSeconds = plant.water / crop.waterUse
    growSeconds = Math.min(elapsed, wateredSeconds)
    plant.water = Math.max(0, plant.water - elapsed * crop.waterUse)
  }
  if (!tempOk) growSeconds = 0
  plant.progress = Math.min(
    crop.growSeconds,
    plant.progress + growSeconds * Math.max(1, plant.boost),
  )
}

/** Growth fraction 0..1 (1 = harvestable). */
export function plantProgress(plant: PlantState, crop: CropDef): number {
  return Math.min(1, plant.progress / crop.growSeconds)
}

export function isMature(plant: PlantState, crop: CropDef): boolean {
  return plant.progress >= crop.growSeconds
}

/** Visual stage bucket [0, crop.stages). */
export function plantStage(plant: PlantState, crop: CropDef): number {
  return Math.min(crop.stages - 1, Math.floor(plantProgress(plant, crop) * crop.stages))
}

/** Tops up the plant's water. Returns true if it was thirsty. */
export function waterPlant(plant: PlantState, amount = 1): boolean {
  const was = plant.water
  plant.water = Math.min(1, plant.water + amount)
  return was < 0.98
}

/** Applies fertilizer once per growth. Returns false if already boosted. */
export function fertilizePlant(plant: PlantState, boost: number): boolean {
  if (plant.boost > 1) return false
  plant.boost = boost
  return true
}

/**
 * Harvest transition: regrowing crops keep their roots (progress resets to
 * the regrow fraction, boost is spent); single-harvest crops clear the
 * planter. The CALLER grants yield items — this only owns state.
 */
export function harvestPlant(
  plant: PlantState,
  crop: CropDef,
  nowMs: number,
): 'regrowing' | 'cleared' {
  if (crop.regrowFraction !== undefined) {
    plant.progress = crop.growSeconds * crop.regrowFraction
    plant.boost = 1
    plant.updatedAt = nowMs
    return 'regrowing'
  }
  return 'cleared'
}

/**
 * Migrates the pre-Stage-4 plant shape ({seedId, plantedAt}) using the
 * seed item's crop reference. Returns null when the seed no longer maps.
 */
export function migrateLegacyPlant(
  raw: { seedId?: string; plantedAt?: number },
  cropIdOfSeed: (seedId: string) => string | undefined,
  nowMs: number,
): PlantState | null {
  if (!raw.seedId || typeof raw.plantedAt !== 'number') return null
  const crop = cropIdOfSeed(raw.seedId)
  if (!crop) return null
  return {
    crop,
    progress: Math.max(0, (nowMs - raw.plantedAt) / 1000),
    water: 1,
    boost: 1,
    updatedAt: nowMs,
  }
}
