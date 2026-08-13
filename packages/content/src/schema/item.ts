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

  /** Present iff planting this item in a planter grows the named crop. */
  seed: z.object({ crop: z.string() }).optional(),

  /** Present iff the placed prop accepts seeds (E with seeds plants). */
  planter: z.object({}).optional(),

  /** Present iff the item carries water (watering cans). Fill from world
   * water or a tank; E on a planter waters the plant. Stack meta `fluid`
   * tracks the current amount. */
  fluidContainer: z.object({ capacity: z.number().int().positive() }).optional(),

  /** Present iff E on a planter applies a one-time growth boost. */
  fertilizer: z.object({ boost: z.number().positive().max(3) }).optional(),

  /** Present iff the item burns as machine/generator fuel. */
  fuel: z.object({ burnSeconds: z.number().positive() }).optional(),

  /**
   * Present iff the placed prop auto-processes machine recipes from its
   * container: inputs in the first `inputSlots`, products land in the
   * remaining `outputSlots`. Needs a nearby running generator if
   * `needsPower`.
   */
  machine: z
    .object({
      kind: z.string().regex(/^[a-z0-9_]+$/),
      inputSlots: z.number().int().positive(),
      outputSlots: z.number().int().positive(),
      needsPower: z.boolean().default(false),
    })
    .optional(),

  /** Present iff the placed prop provides power in a radius while fueled
   * (fuel items burn from its container). */
  powerProducer: z
    .object({
      radius: z.number().positive(),
    })
    .optional(),

  /** Present iff the placed prop stores water: fills in rain, fillable
   * with a watering can, drained by sprinklers. */
  waterTank: z.object({ capacity: z.number().positive() }).optional(),

  /** Present iff the placed prop waters planters in a radius, drawing
   * from the nearest tank within `tankRange`. */
  sprinkler: z
    .object({
      radius: z.number().positive(),
      tankRange: z.number().positive().default(6),
    })
    .optional(),

  /** Present iff the placed prop is an NPC trading post (E opens the shop). */
  shop: z.object({}).optional(),

  /** Present iff the placed prop is a hinged door (E toggles when frozen). */
  door: z.object({ openAngle: z.number().default(1.75) }).optional(),

  /** Present iff the placed prop stores items (storage boxes, chests). */
  container: z
    .object({
      slots: z.number().int().positive(),
    })
    .optional(),

  /** Present iff the item is a purpose-built melee weapon (damage override).
   * Any held item can swing — this capability makes it GOOD at it. Ranged
   * weapons will extend this shape (projectile, ammo) rather than fork it. */
  weapon: z
    .object({
      damage: z.number().positive(),
      range: z.number().positive().default(2.6),
    })
    .optional(),

  /** Present iff the item fires server-validated hitscan shots. The
   * per-instance magazine/cadence state lives in stack meta. */
  rangedWeapon: z
    .object({
      damage: z.number().positive(),
      range: z.number().positive(),
      fireIntervalMs: z.number().positive(),
      spreadDeg: z.number().min(0).max(20).default(1.5),
      ammoItem: z.string(),
      magazine: z.number().int().positive(),
      reloadMs: z.number().positive(),
    })
    .optional(),

  /** Present iff the item is ammunition (referenced by rangedWeapon.ammoItem). */
  ammo: z.object({}).optional(),

  /** Present iff the item is wearable protection (one armor slot). Stack
   * meta `dur` tracks remaining durability; the piece breaks at 0. */
  armor: z
    .object({
      /** Fraction of mitigable damage absorbed. */
      reduction: z.number().min(0).max(0.9),
      /** Hits absorbed before the piece breaks. */
      durability: z.number().int().positive(),
    })
    .optional(),

  /** Present iff consuming the item treats wounds (bandages, medkits). */
  medical: z
    .object({
      heal: z.number().nonnegative().default(0),
      curesBleeding: z.boolean().default(false),
    })
    .optional(),

  /**
   * Present iff the placed prop is damageable/destructible. Health is NOT
   * automatic — only structures/objects where destruction is gameplay get
   * it. Zone rules still gate attacks (safe areas forbid destruction).
   */
  health: z
    .object({
      max: z.number().positive(),
      /** Incoming damage multiplier (0.5 = armored). */
      resistance: z.number().min(0).max(1).default(1),
      /** E with this material equipped repairs the prop. */
      repair: z
        .object({
          item: z.string(),
          count: z.number().int().positive().default(1),
          restore: z.number().positive(),
        })
        .optional(),
      /** Items scattered when the prop is destroyed (salvage). */
      destroyLoot: z
        .array(z.object({ item: z.string(), count: z.number().int().positive() }))
        .default([]),
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
      kind: z.enum(['physgun', 'axe', 'pickaxe', 'rigging']),
      /** Harvest units per swing (multiplies node perUse). */
      power: z.number().int().positive().default(1),
      /** Use range in meters. */
      range: z.number().positive().default(4),
    })
    .optional(),
})

export type ItemDef = z.infer<typeof ItemDefSchema>
export type WorldShape = z.infer<typeof WorldShapeSchema>
