import { z } from 'zod'

/**
 * Player appearance: a compact, validated description of a customizable
 * low-poly avatar. Values are palette/style INDICES (not colors) so the
 * wire format stays stable while the client's palettes evolve. Scales are
 * clamped — appearance must never affect hitboxes or movement, only the
 * visual rig, so the ranges are cosmetic-safe.
 */
export const HAIR_STYLES = ['buzz', 'short', 'bun', 'messy', 'long', 'ponytail', 'bald'] as const
export const FACIAL_HAIR = ['none', 'mustache', 'goatee', 'full'] as const

export const AppearanceSchema = z.object({
  body: z.enum(['male', 'female']),
  /** Skin tone palette index. */
  skin: z.number().int().min(0).max(7),
  hairStyle: z.enum(HAIR_STYLES),
  hairColor: z.number().int().min(0).max(7),
  facialHair: z.enum(FACIAL_HAIR),
  /** Outfit palette indices (top / bottom / shoes). */
  top: z.number().int().min(0).max(9),
  bottom: z.number().int().min(0).max(9),
  shoes: z.number().int().min(0).max(9),
  /** Cosmetic-only proportion tweaks. */
  height: z.number().min(0.92).max(1.08),
  build: z.number().min(0.85).max(1.15),
})

export type Appearance = z.infer<typeof AppearanceSchema>

export function defaultAppearance(): Appearance {
  return {
    body: 'male',
    skin: 2,
    hairStyle: 'short',
    hairColor: 1,
    facialHair: 'none',
    top: 0,
    bottom: 1,
    shoes: 2,
    height: 1,
    build: 1,
  }
}

/** Deterministic-ish random look for fresh players (fed by any RNG fn). */
export function randomAppearance(rand: () => number): Appearance {
  const pick = (n: number) => Math.floor(rand() * n)
  const body = rand() < 0.5 ? 'male' : 'female'
  return {
    body,
    skin: pick(8),
    hairStyle: HAIR_STYLES[pick(HAIR_STYLES.length - 1)] ?? 'short',
    hairColor: pick(8),
    facialHair: body === 'male' && rand() < 0.4 ? (FACIAL_HAIR[1 + pick(3)] ?? 'none') : 'none',
    top: pick(10),
    bottom: pick(10),
    shoes: pick(10),
    height: 0.95 + rand() * 0.1,
    build: 0.9 + rand() * 0.2,
  }
}
