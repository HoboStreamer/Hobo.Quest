import { z } from 'zod'

export const RecipeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  category: z.enum([
    'construction',
    'tools',
    'weapons',
    'farming',
    'food',
    'survival',
    'furniture',
    'machines',
    'electrical',
    'vehicles',
    'processing',
    'misc',
  ]),
  inputs: z
    .array(
      z.object({
        item: z.string(),
        count: z.number().int().positive(),
      }),
    )
    .min(1),
  outputs: z
    .array(
      z.object({
        item: z.string(),
        count: z.number().int().positive(),
      }),
    )
    .min(1),
  /** Seconds of crafting time; converted to ticks by the server. */
  craftSeconds: z.number().nonnegative().default(0),
  /** Workstation kind required in range, if any. */
  workstation: z.string().optional(),
  /**
   * Machine kind that processes this recipe AUTOMATICALLY from its own
   * container (unattended production). Mutually exclusive with hand
   * crafting: machine recipes never appear in the player craft menu.
   */
  machine: z.string().optional(),
  /** Blueprint recipes are NOT known by default: a blueprint item, job or
   * reward must unlock them per player. */
  blueprint: z.boolean().optional(),
  /** Skill gates — enforced once the skill system lands; validated now. */
  requiredSkill: z.object({ skill: z.string(), level: z.number().int().min(1) }).optional(),
})

export type Recipe = z.infer<typeof RecipeSchema>
