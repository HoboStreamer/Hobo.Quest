import { z } from 'zod'

export const SkillDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  maxLevel: z.number().int().min(2).max(100).default(50),
})

export type SkillDef = z.infer<typeof SkillDefSchema>

/**
 * XP required to advance FROM a given level (shared by server and UI).
 * Gentle early curve so first unlocks arrive within minutes of gathering.
 */
export function xpToNextLevel(level: number): number {
  return Math.round(60 * Math.pow(level, 1.45))
}
