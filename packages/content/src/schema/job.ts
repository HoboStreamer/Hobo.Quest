import { z } from 'zod'

/**
 * Jobs/contracts: data-driven objectives offered at markets. Deliver jobs
 * consume items on turn-in; kill jobs count faction kills. Rewards pay
 * coins, reputation, XP and sometimes items (blueprints!).
 */
export const JobSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Market that offers and settles this job. */
  market: z.string(),
  objective: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('deliver'),
      item: z.string(),
      count: z.number().int().positive(),
    }),
    z.object({
      kind: z.literal('kill'),
      archetype: z.string(),
      count: z.number().int().positive(),
    }),
  ]),
  reward: z.object({
    coins: z.number().int().nonnegative().default(0),
    reputation: z.number().int().default(0),
    items: z.array(z.object({ item: z.string(), count: z.number().int().positive() })).default([]),
    xp: z.object({ skill: z.string(), amount: z.number().int().positive() }).optional(),
  }),
})

export type JobDef = z.infer<typeof JobSchema>
