/**
 * Survival vitals, server-authoritative and UI-agnostic. Pure state +
 * transition functions: the server ticks these once a second per player;
 * eating, damage and death act through the same small API.
 *
 * Temperature and statuses use understandable gameplay rules, not
 * thermodynamics: ambient temperature (environment) is modified by heat
 * sources and wetness, drags body temperature away from 37°C, and the
 * body temperature bands produce cold/freezing/overheated statuses with
 * legible consequences.
 */

export interface SurvivalStats {
  health: number
  hunger: number
  thirst: number
  stamina: number
  /** Body temperature °C (37 = normal). */
  bodyTemp: number
  /** Active timed statuses: id -> expiry (epoch ms). */
  statuses: Record<string, number>
}

/** Everything the environment/world contributes to one survival tick. */
export interface SurvivalContext {
  sprinting: boolean
  /** Ambient air temperature °C at the player (environment + weather). */
  ambientC: number
  /** Standing in water or out in rain. */
  wet: boolean
  /** Within range of a campfire or similar heat source. */
  nearHeat: boolean
  nowMs: number
}

export const STAT_MAX = 100
export const BODY_TEMP_NORMAL = 37

/**
 * Status ids with gameplay effects. Data-driven where sensible: each entry
 * documents its consequence; the tick applies them generically where it
 * can (dps) and specifically where the rule is structural (regen bands).
 */
export const STATUS_DEFS = {
  /** Soaked: worsens effective temperature (applied while exposed). */
  wet: { dps: 0 },
  /** Body temp < 35: stamina regeneration halved. */
  cold: { dps: 0 },
  /** Body temp < 33.5: actively losing health. */
  freezing: { dps: 1.2 },
  /** Body temp > 39: thirst drains fast (handled structurally). */
  overheated: { dps: 0 },
  /** Big meal: passive regen boosted. */
  well_fed: { dps: 0 },
  /** Open wound: losing health until treated (combat applies this). */
  bleeding: { dps: 0.8 },
} as const

export type StatusId = keyof typeof STATUS_DEFS

/** Hunger drains to zero over ~40 real minutes, thirst over ~30. */
const HUNGER_PER_SEC = STAT_MAX / (40 * 60)
const THIRST_PER_SEC = STAT_MAX / (30 * 60)
/** Starvation/dehydration damage; well-fed players slowly regenerate. */
const STARVE_DPS = 1.5
const REGEN_PER_SEC = 1
const SPRINT_STAMINA_PER_SEC = 7
const STAMINA_REGEN_PER_SEC = 11

/**
 * Comfort band edges for EFFECTIVE ambient temperature, °C. Clear nights
 * bottom out around 6°C — safe. Rain/storm/fog nights and wetness push
 * below the chill line, so bad weather is what demands fire and shelter.
 */
const CHILL_BELOW = 2
const SWELTER_ABOVE = 32
/** Body temp drift rates, °C per second. */
const BODY_COOL_RATE = 0.02
const BODY_HEAT_RATE = 0.02
const BODY_RECOVER_RATE = 0.035

export function createStats(): SurvivalStats {
  return {
    health: STAT_MAX,
    hunger: STAT_MAX,
    thirst: STAT_MAX,
    stamina: STAT_MAX,
    bodyTemp: BODY_TEMP_NORMAL,
    statuses: {},
  }
}

/** Fills fields older saves lack (players from before temperature). */
export function normalizeStats(raw: Partial<SurvivalStats> | null | undefined): SurvivalStats {
  const base = createStats()
  if (!raw) return base
  return {
    health: raw.health ?? base.health,
    hunger: raw.hunger ?? base.hunger,
    thirst: raw.thirst ?? base.thirst,
    stamina: raw.stamina ?? base.stamina,
    bodyTemp: raw.bodyTemp ?? base.bodyTemp,
    statuses: raw.statuses ?? {},
  }
}

const clamp = (v: number) => Math.max(0, Math.min(STAT_MAX, v))

export function applyStatus(
  stats: SurvivalStats,
  id: StatusId,
  durationSec: number,
  nowMs: number,
): void {
  const until = nowMs + durationSec * 1000
  if ((stats.statuses[id] ?? 0) < until) stats.statuses[id] = until
}

export function clearStatus(stats: SurvivalStats, id: StatusId): void {
  delete stats.statuses[id]
}

export function hasStatus(stats: SurvivalStats, id: StatusId, nowMs: number): boolean {
  return (stats.statuses[id] ?? 0) > nowMs
}

/** Active status ids (expired ones are pruned in place). */
export function activeStatuses(stats: SurvivalStats, nowMs: number): StatusId[] {
  const active: StatusId[] = []
  for (const id of Object.keys(stats.statuses) as StatusId[]) {
    if (!(id in STATUS_DEFS) || (stats.statuses[id] ?? 0) <= nowMs) {
      delete stats.statuses[id]
    } else {
      active.push(id)
    }
  }
  return active
}

/** Advances vitals by dt seconds. Returns true if the player just died. */
export function tickSurvival(stats: SurvivalStats, dt: number, ctx: SurvivalContext): boolean {
  if (stats.health <= 0) return false

  // ── Exposure → body temperature ─────────────────────────────────────
  if (ctx.wet) applyStatus(stats, 'wet', 20, ctx.nowMs)
  const wet = hasStatus(stats, 'wet', ctx.nowMs)
  const effectiveC = ctx.ambientC + (ctx.nearHeat ? 18 : 0) - (wet ? 7 : 0)
  if (effectiveC < CHILL_BELOW) {
    stats.bodyTemp -= BODY_COOL_RATE * (CHILL_BELOW - effectiveC) * dt
  } else if (effectiveC > SWELTER_ABOVE) {
    stats.bodyTemp += BODY_HEAT_RATE * (effectiveC - SWELTER_ABOVE) * dt
  } else {
    const back = BODY_RECOVER_RATE * dt
    if (stats.bodyTemp < BODY_TEMP_NORMAL) {
      stats.bodyTemp = Math.min(BODY_TEMP_NORMAL, stats.bodyTemp + back)
    } else {
      stats.bodyTemp = Math.max(BODY_TEMP_NORMAL, stats.bodyTemp - back)
    }
  }
  stats.bodyTemp = Math.max(28, Math.min(43, stats.bodyTemp))

  // Temperature bands set/clear their statuses each tick.
  if (stats.bodyTemp < 33.5) {
    applyStatus(stats, 'freezing', 2, ctx.nowMs)
    applyStatus(stats, 'cold', 2, ctx.nowMs)
  } else if (stats.bodyTemp < 35) {
    applyStatus(stats, 'cold', 2, ctx.nowMs)
    clearStatus(stats, 'freezing')
  } else {
    clearStatus(stats, 'cold')
    clearStatus(stats, 'freezing')
  }
  if (stats.bodyTemp > 39) applyStatus(stats, 'overheated', 2, ctx.nowMs)
  else clearStatus(stats, 'overheated')

  // ── Hunger / thirst / stamina ───────────────────────────────────────
  const thirstRate = hasStatus(stats, 'overheated', ctx.nowMs) ? 2.5 : 1
  stats.hunger = clamp(stats.hunger - HUNGER_PER_SEC * dt)
  stats.thirst = clamp(stats.thirst - THIRST_PER_SEC * thirstRate * dt)
  const staminaRegen = hasStatus(stats, 'cold', ctx.nowMs)
    ? STAMINA_REGEN_PER_SEC * 0.5
    : STAMINA_REGEN_PER_SEC
  stats.stamina = clamp(
    stats.stamina + (ctx.sprinting ? -SPRINT_STAMINA_PER_SEC : staminaRegen) * dt,
  )

  // ── Health: statuses drain, food + warmth regenerate ────────────────
  let statusDps = 0
  for (const id of activeStatuses(stats, ctx.nowMs)) statusDps += STATUS_DEFS[id].dps
  if (statusDps > 0) stats.health = clamp(stats.health - statusDps * dt)

  if (stats.hunger <= 0 || stats.thirst <= 0) {
    stats.health = clamp(stats.health - STARVE_DPS * dt)
  } else if (stats.hunger > 60 && stats.thirst > 60 && stats.health > 0 && statusDps === 0) {
    const regen = hasStatus(stats, 'well_fed', ctx.nowMs) ? REGEN_PER_SEC * 1.6 : REGEN_PER_SEC
    stats.health = clamp(stats.health + regen * dt)
  }
  return stats.health <= 0
}

/** Applies a food item's restoration. Big meals leave you well fed. */
export function eat(
  stats: SurvivalStats,
  food: { hunger: number; thirst: number; health: number },
  nowMs = 0,
): void {
  stats.hunger = clamp(stats.hunger + food.hunger)
  stats.thirst = clamp(stats.thirst + food.thirst)
  stats.health = clamp(stats.health + food.health)
  if (food.hunger >= 30 && nowMs > 0) applyStatus(stats, 'well_fed', 120, nowMs)
}

/** Applies damage. Returns true if this killed the player. */
export function applyDamage(stats: SurvivalStats, amount: number): boolean {
  if (stats.health <= 0) return false
  stats.health = clamp(stats.health - amount)
  return stats.health <= 0
}
