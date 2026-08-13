import { z } from 'zod'

/**
 * NPC content: archetypes are data — display, faction, vitals, perception,
 * behavior profile, loot. Behavior is COMPOSED from profile fields
 * (aggression/flees/patrols), never from archetype-specific code paths.
 */

export const NpcArchetypeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  faction: z.string(),
  health: z.number().positive(),
  /** Meters per second while moving. */
  moveSpeed: z.number().positive(),
  /** Placeholder visual: capsule tint until real models exist. */
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  /** Capsule dimensions (visual + collision). */
  radius: z.number().positive().default(0.35),
  heightM: z.number().positive().default(1.7),

  perception: z.object({
    viewDistance: z.number().positive(),
    /** Field of view, radians (full angle). */
    fov: z
      .number()
      .positive()
      .max(Math.PI * 2),
    hearingDistance: z.number().nonnegative(),
  }),

  behavior: z.object({
    /**
     * hostile: attacks visible players. defensive: attacks recent
     * aggressors only. passive: never attacks.
     */
    aggression: z.enum(['hostile', 'defensive', 'passive']),
    /** Runs from threats instead of ignoring them (wildlife, civilians). */
    flees: z.boolean().default(false),
    /** Wanders around its home point while idle. */
    wanders: z.boolean().default(true),
    /** Max distance from home before it turns back. */
    leash: z.number().positive().default(30),
    attackDamage: z.number().nonnegative().default(0),
    attackRange: z.number().positive().default(1.8),
    attackIntervalMs: z.number().positive().default(1500),
  }),

  /** Items scattered on death. */
  loot: z
    .array(
      z.object({
        item: z.string(),
        count: z.number().int().positive(),
        chance: z.number().min(0).max(1).default(1),
      }),
    )
    .default([]),

  /** Seconds until a killed NPC respawns at home. */
  respawnSeconds: z.number().positive().default(180),
})

export type NpcArchetype = z.infer<typeof NpcArchetypeSchema>

/** Faction relations: how members react to other factions and players. */
export const FactionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  /** Default stance toward players (reputation shifts this in Stage 8). */
  playerStance: z.enum(['friendly', 'neutral', 'hostile']),
})

export type FactionDef = z.infer<typeof FactionSchema>
