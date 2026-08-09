import { z } from 'zod'
import { WorldShapeSchema } from './item.js'

/**
 * Resource node types: the data behind gathering professions. World
 * definitions place instances by type id; behavior (yield, tool gating,
 * respawn, XP) lives here so a new gatherable is pure content.
 */
export const ResourceNodeTypeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  /** Item def yielded per gather. */
  item: z.string(),
  /** Total units before the node is depleted. */
  amount: z.number().int().positive(),
  /** Units yielded per hand gather (tool power multiplies this). */
  perUse: z.number().int().positive().default(1),
  /** Tool kind required to harvest; absent = gatherable by hand (E). */
  requiredTool: z.enum(['axe', 'pickaxe']).optional(),
  /** Seconds until a depleted node refills (persistent world must not run dry). */
  respawnSeconds: z.number().positive(),
  skill: z.string(),
  xpPerGather: z.number().int().nonnegative().default(0),
  /** Client visual archetype. */
  visual: z.enum(['tree', 'rock', 'scrap', 'branches', 'stones']),
  /** Collision body (blocks movement, receives aim rays). */
  bodyShape: WorldShapeSchema,
  /** Body center height above the placed ground position. */
  bodyOffsetY: z.number().default(0.5),
})

export type ResourceNodeType = z.infer<typeof ResourceNodeTypeSchema>
