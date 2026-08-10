/**
 * Survival vitals, server-authoritative and UI-agnostic. Pure state +
 * transition functions: the server ticks these once a second per player;
 * eating, damage and death act through the same small API. Temperature and
 * richer status effects become new fields + rules here, not new systems.
 */

export interface SurvivalStats {
  health: number
  hunger: number
  thirst: number
  stamina: number
}

export const STAT_MAX = 100

/** Hunger drains to zero over ~40 real minutes, thirst over ~30. */
const HUNGER_PER_SEC = STAT_MAX / (40 * 60)
const THIRST_PER_SEC = STAT_MAX / (30 * 60)
/** Starvation/dehydration damage; well-fed players slowly regenerate. */
const STARVE_DPS = 1.5
const REGEN_PER_SEC = 1
const SPRINT_STAMINA_PER_SEC = 7
const STAMINA_REGEN_PER_SEC = 11

export function createStats(): SurvivalStats {
  return { health: STAT_MAX, hunger: STAT_MAX, thirst: STAT_MAX, stamina: STAT_MAX }
}

const clamp = (v: number) => Math.max(0, Math.min(STAT_MAX, v))

/** Advances vitals by dt seconds. Returns true if the player just died. */
export function tickSurvival(stats: SurvivalStats, dt: number, sprinting: boolean): boolean {
  if (stats.health <= 0) return false
  stats.hunger = clamp(stats.hunger - HUNGER_PER_SEC * dt)
  stats.thirst = clamp(stats.thirst - THIRST_PER_SEC * dt)
  stats.stamina = clamp(
    stats.stamina + (sprinting ? -SPRINT_STAMINA_PER_SEC : STAMINA_REGEN_PER_SEC) * dt,
  )
  if (stats.hunger <= 0 || stats.thirst <= 0) {
    stats.health = clamp(stats.health - STARVE_DPS * dt)
  } else if (stats.hunger > 60 && stats.thirst > 60 && stats.health > 0) {
    stats.health = clamp(stats.health + REGEN_PER_SEC * dt)
  }
  return stats.health <= 0
}

/** Applies a food item's restoration. */
export function eat(
  stats: SurvivalStats,
  food: { hunger: number; thirst: number; health: number },
): void {
  stats.hunger = clamp(stats.hunger + food.hunger)
  stats.thirst = clamp(stats.thirst + food.thirst)
  stats.health = clamp(stats.health + food.health)
}

/** Applies damage. Returns true if this killed the player. */
export function applyDamage(stats: SurvivalStats, amount: number): boolean {
  if (stats.health <= 0) return false
  stats.health = clamp(stats.health - amount)
  return stats.health <= 0
}
