import { z } from 'zod'

/**
 * Unified item definitions: one definition describes every representation of
 * a conceptual item — inventory stack, physical world entity, functional
 * capabilities, persistence — via optional capability blocks (composition,
 * not an inheritance tree). Systems check for the capability they need:
 * placement checks `placeable`, physics spawning checks `world`, and so on.
 * Future capabilities (powerProducer, container, growable...) are added as
 * new optional blocks without touching existing items.
 */

/** Simple collision/render primitives for dynamic objects. Detailed meshes come later, and only for statics. */
export const WorldShapeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('box'),
    /** Full extents, meters. */
    size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
  }),
  z.object({
    type: z.literal('cylinder'),
    radius: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({ type: z.literal('sphere'), radius: z.number().positive() }),
])

export const ItemDefSchema = z.object({
  /** Stable id — never a display name; display names may change freely. */
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  description: z.string().default(''),
  /** Loose grouping for UI/filtering only — carries no behavior. */
  category: z.enum([
    'material',
    'resource',
    'tool',
    'placeable',
    'building',
    'food',
    'seed',
    'component',
    'misc',
  ]),
  /** Stacking: maxStack 1 = non-stackable. */
  maxStack: z.number().int().min(1).max(9999).default(1),

  /** Physical world representation — present iff the item can exist as a world entity. */
  world: z
    .object({
      shape: WorldShapeSchema,
      massKg: z.number().positive(),
      /** Placeholder visual: primitive + color until real assets exist. */
      color: z.string().regex(/^#[0-9a-f]{6}$/),
      /** Can the physgun manipulate it? */
      physgun: z.boolean().default(true),
    })
    .optional(),

  /** Present iff the item can be eaten/drunk (consumed from the hotbar). */
  food: z
    .object({
      hunger: z.number().default(0),
      thirst: z.number().default(0),
      health: z.number().default(0),
    })
    .optional(),

  /** Present iff the placed prop is a hinged door (E toggles when frozen). */
  door: z.object({ openAngle: z.number().default(1.75) }).optional(),

  /** Present iff the placed prop stores items (storage boxes, chests). */
  container: z
    .object({
      slots: z.number().int().positive(),
    })
    .optional(),

  /** Present iff the item can be placed from inventory into the world. */
  placeable: z
    .object({
      /** Max distance from player eye to placement point, meters. */
      maxRange: z.number().positive().default(3.5),
      /** Optional grid snap step in meters (0 = free placement only). */
      snapStep: z.number().nonnegative().default(0),
    })
    .optional(),

  /** Present iff the entity acts as a crafting workstation. */
  workstation: z
    .object({
      /** Recipes may require one of these station kinds. */
      kind: z.string().regex(/^[a-z0-9_]+$/),
      range: z.number().positive().default(3),
    })
    .optional(),

  /**
   * Present iff the item is a usable hand tool. The equipped hotbar item's
   * tool capability decides what primary fire does (physgun beam, harvest
   * swing, weld). Combat weapons will be a sibling capability, not a
   * special case of this one.
   */
  tool: z
    .object({
      kind: z.enum(['physgun', 'axe', 'pickaxe', 'hammer']),
      /** Harvest units per swing (multiplies node perUse). */
      power: z.number().int().positive().default(1),
      /** Use range in meters. */
      range: z.number().positive().default(4),
    })
    .optional(),
})

export type ItemDef = z.infer<typeof ItemDefSchema>
export type WorldShape = z.infer<typeof WorldShapeSchema>
