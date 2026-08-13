import { z } from 'zod'

/**
 * Data-driven crops: what grows from a seed, how fast, what it needs, and
 * what harvesting yields. Growth is always timestamp-derived — plants never
 * tick. A crop is content; the planter/plant systems never know specific
 * crop names.
 */
export const CropDefSchema = z.object({
  /** Stable id — never a display name. */
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  /** Seconds of WATERED growth from planting to harvestable. */
  growSeconds: z.number().positive(),
  /** Visual growth stages the client may render (progress buckets). */
  stages: z.number().int().min(2).max(6).default(3),
  /**
   * Water consumption in units/second of growth ([0..1] tank per plant).
   * 0 = drought-proof (grows unwatered). Higher = thirstier: growth pauses
   * while the plant's water tank is empty; rain keeps it full.
   */
  waterUse: z.number().min(0).max(0.01).default(0.002),
  /** Ambient °C band in which the crop grows; outside it, growth pauses. */
  temperature: z.object({ min: z.number(), max: z.number() }).default({ min: 2, max: 40 }),
  /** Harvest yield. */
  yield: z.array(z.object({ item: z.string(), count: z.number().int().positive() })).min(1),
  /**
   * Regrow: harvesting resets progress to this fraction instead of
   * clearing the planter (bushes/vines). Absent = single harvest.
   */
  regrowFraction: z.number().min(0).max(0.9).optional(),
  /** Farming level required to plant. */
  requiredLevel: z.number().int().min(1).default(1),
  /** Placeholder visual color for the growing plant. */
  color: z.string().regex(/^#[0-9a-f]{6}$/),
})

export type CropDef = z.infer<typeof CropDefSchema>
