import { z } from 'zod'
import { AppearanceSchema } from '../appearance.js'

/**
 * Client -> server messages, defined as zod schemas because the server must
 * treat every inbound byte as hostile. Types are inferred from schemas so
 * validation and typing can never drift apart.
 */

export const ClientHelloSchema = z.object({
  t: z.literal('hello'),
  v: z.number().int(),
  /** Persistent identity token (localStorage). Replaced by real auth later. */
  token: z.string().min(8).max(64),
  /** hobo.tools session token (a JWT — they run long); absent for guests. */
  auth: z.string().min(1).max(2048).optional(),
  /** Character slot under this account (MMO-style, 3 max). */
  slot: z.number().int().min(0).max(2).default(0),
  name: z.string().min(1).max(24),
  appearance: AppearanceSchema,
})

/**
 * One input command per simulation tick. The client sends these at tick rate;
 * `seq` is echoed in snapshots for prediction reconciliation. The server
 * validates command counts to prevent speedup, and simulates movement itself —
 * the client never reports a position.
 */
/** Admin/owner only: toggle edit mode (noclip fly). Server checks rank. */
export const ClientEditModeSchema = z.object({
  t: z.literal('editmode'),
  on: z.boolean(),
})

export const ClientInputSchema = z.object({
  t: z.literal('input'),
  seq: z.number().int().nonnegative(),
  moveX: z.number().min(-1).max(1),
  moveZ: z.number().min(-1).max(1),
  yaw: z.number().finite(),
  pitch: z.number().finite(),
  buttons: z.number().int().nonnegative(),
})

/** Interact with a world entity (gather a resource, open a container...). */
export const ClientUseSchema = z.object({
  t: z.literal('use'),
  target: z.string().max(32),
})

/** Melee swing at an entity (another player, or a damageable prop). */
export const ClientAttackSchema = z.object({
  t: z.literal('attack'),
  target: z.string().max(32),
})

/** Fire the equipped ranged weapon. No aim data: the server shoots along
 * the player's AUTHORITATIVE view (from movement inputs) plus spread. */
export const ClientFireSchema = z.object({
  t: z.literal('fire'),
})

/** Reload the equipped ranged weapon from inventory ammo. */
export const ClientReloadSchema = z.object({
  t: z.literal('reload'),
})

/** Wear the armor item in the given inventory slot (swaps with current). */
export const ClientEquipArmorSchema = z.object({
  t: z.literal('equip_armor'),
  /** Inventory slot to equip from; omit to unequip into the inventory. */
  slot: z.number().int().min(0).max(63).optional(),
})

export const ClientCraftSchema = z.object({
  t: z.literal('craft'),
  recipe: z.string().max(64),
})

/**
 * Drop items from a slot into the world (they become physical props).
 * Dropping IS placement: crafted pieces are dropped, then positioned and
 * frozen with the physgun.
 */
export const ClientDropSchema = z.object({
  t: z.literal('drop'),
  slot: z.number().int().nonnegative().max(255),
  count: z.number().int().positive().max(9999),
})

/**
 * Precise placement from the ghost preview: the item in `slot` becomes a
 * dynamic prop at the requested pose. The server validates range, zone,
 * bounds and the item's placeable capability — physics resolves any
 * overlap the client lied about (the prop is never spawned frozen).
 */
export const ClientPlaceSchema = z.object({
  t: z.literal('place'),
  slot: z.number().int().nonnegative().max(255),
  pos: z.tuple([
    z.number().min(-2000).max(2000),
    z.number().min(-100).max(500),
    z.number().min(-2000).max(2000),
  ]),
  yaw: z.number().finite(),
})

export const ClientInvMoveSchema = z.object({
  t: z.literal('inv_move'),
  from: z.number().int().nonnegative().max(255),
  to: z.number().int().nonnegative().max(255),
  /** When present, split: move only `count` items from the stack. */
  count: z.number().int().positive().max(9999).optional(),
})

export const ClientHotbarSelectSchema = z.object({
  t: z.literal('hotbar'),
  slot: z.number().int().nonnegative().max(15),
})

/**
 * Physgun commands. The client only ever expresses intent; the server
 * raycasts from the player's authoritative view, owns the grab state and
 * drives the held body.
 */
export const ClientPhysgunSchema = z.discriminatedUnion('a', [
  z.object({ t: z.literal('physgun'), a: z.literal('grab') }),
  z.object({ t: z.literal('physgun'), a: z.literal('release') }),
  z.object({
    t: z.literal('physgun'),
    a: z.literal('adjust'),
    /** Push/pull hold distance, meters per command. */
    dist: z.number().min(-2).max(2),
  }),
  z.object({
    t: z.literal('physgun'),
    a: z.literal('rotate'),
    /** Incremental rotation of the held object, radians (clamped). */
    dyaw: z.number().min(-1).max(1),
    dpitch: z.number().min(-1).max(1),
    /** Snap rotation to increments (precision mode). */
    snap: z.boolean().optional(),
    /** Snap increment in radians (defaults to 15°). */
    snapStep: z.number().min(0.02).max(1.6).optional(),
  }),
  z.object({ t: z.literal('physgun'), a: z.literal('freeze') }),
  z.object({ t: z.literal('physgun'), a: z.literal('unfreeze'), target: z.string().max(32) }),
  /** Grid-lock: snap the held prop's drive target to a grid. */
  z.object({
    t: z.literal('physgun'),
    a: z.literal('grid'),
    on: z.boolean(),
    /** Grid cell size in meters (defaults to 0.25). */
    size: z.number().min(0.05).max(2).optional(),
  }),
])

/**
 * Trust management (prop protection): allow/revoke another player's right
 * to manipulate my props. One-directional and persistent.
 */
export const ClientTrustSchema = z.object({
  t: z.literal('trust'),
  player: z.string().max(32),
  trusted: z.boolean(),
})

const WorldPoint = z.tuple([
  z.number().min(-2000).max(2000),
  z.number().min(-2000).max(2000),
  z.number().min(-2000).max(2000),
])

/**
 * Create a constraint between two props with the rigging tool. Points are
 * the world-space click locations on each prop; the server converts them
 * to authoritative body-local anchors (clamped) and validates everything:
 * type params, skill, materials, range, zone, ownership, limits.
 */
export const ClientConstraintSchema = z.object({
  t: z.literal('constraint'),
  kind: z.enum(['weld', 'rope', 'hinge', 'axis', 'slider', 'spring', 'motor']),
  a: z.string().max(32),
  b: z.string().max(32),
  pointA: WorldPoint,
  pointB: WorldPoint,
  /** Joint axis in world space (hinge/axis/slider/motor). */
  axis: z.tuple([z.number(), z.number(), z.number()]).optional(),
  /** Rope/spring length override (defaults to the current anchor gap). */
  length: z.number().min(0.05).max(20).optional(),
  /** Hinge swing (rad) / slider travel (m) limits. */
  limits: z
    .object({ min: z.number().min(-10).max(10), max: z.number().min(-10).max(10) })
    .optional(),
  stiffness: z.number().min(0).max(10000).optional(),
  damping: z.number().min(0).max(1000).optional(),
  motorVel: z.number().min(-50).max(50).optional(),
  motorForce: z.number().min(0).max(100000).optional(),
})

/** Remove all constraints touching the target prop (rigging tool RMB). */
export const ClientConstraintRemoveSchema = z.object({
  t: z.literal('constraint_remove'),
  target: z.string().max(32),
})

/** Eat/drink the food item in the given inventory slot. */
export const ClientConsumeSchema = z.object({
  t: z.literal('consume'),
  slot: z.number().int().min(0).max(63),
})

/** Drink from the water the player is standing in. */
export const ClientDrinkSchema = z.object({
  t: z.literal('drink'),
})

/** Open a trading post's market (server replies with stock + prices). */
export const ClientMarketOpenSchema = z.object({
  t: z.literal('market_open'),
  target: z.string().max(32),
})

/** Buy one sell-bundle from the market this shop prop references. */
export const ClientMarketBuySchema = z.object({
  t: z.literal('market_buy'),
  target: z.string().max(32),
  item: z.string().max(64),
})

/** Sell one buy-bundle to the market. */
export const ClientMarketSellSchema = z.object({
  t: z.literal('market_sell'),
  target: z.string().max(32),
  item: z.string().max(64),
})

/** Accept a contract offered by this trading post. */
export const ClientJobAcceptSchema = z.object({
  t: z.literal('job_accept'),
  target: z.string().max(32),
  job: z.string().max(64),
})

/** Turn in the active contract at this trading post. */
export const ClientJobTurnInSchema = z.object({
  t: z.literal('job_turnin'),
  target: z.string().max(32),
})

/** Open a container prop (server replies with its contents). */
export const ClientContainerOpenSchema = z.object({
  t: z.literal('container_open'),
  target: z.string().max(32),
})

/** Move items between the player inventory and an open container. */
export const ClientContainerMoveSchema = z.object({
  t: z.literal('container_move'),
  target: z.string().max(32),
  /** 'in': player slot -> container; 'out': container slot -> player. */
  dir: z.enum(['in', 'out']),
  slot: z.number().int().min(0).max(63),
  /** When present, split: move only `count` items from the stack. */
  count: z.number().int().positive().max(9999).optional(),
})

/** Compact + sort an open container (merges partial stacks, orders by item). */
export const ClientContainerSortSchema = z.object({
  t: z.literal('container_sort'),
  target: z.string().max(32),
})

export const ClientMessageSchema = z.union([
  ClientEditModeSchema,
  ClientHelloSchema,
  ClientInputSchema,
  ClientUseSchema,
  ClientAttackSchema,
  ClientFireSchema,
  ClientReloadSchema,
  ClientEquipArmorSchema,
  ClientCraftSchema,
  ClientDropSchema,
  ClientPlaceSchema,
  ClientInvMoveSchema,
  ClientHotbarSelectSchema,
  ClientPhysgunSchema,
  ClientTrustSchema,
  ClientConstraintSchema,
  ClientConstraintRemoveSchema,
  ClientConsumeSchema,
  ClientDrinkSchema,
  ClientMarketOpenSchema,
  ClientMarketBuySchema,
  ClientMarketSellSchema,
  ClientJobAcceptSchema,
  ClientJobTurnInSchema,
  ClientContainerOpenSchema,
  ClientContainerMoveSchema,
  ClientContainerSortSchema,
])

export type ClientHello = z.infer<typeof ClientHelloSchema>
export type ClientInput = z.infer<typeof ClientInputSchema>
export type ClientUse = z.infer<typeof ClientUseSchema>
export type ClientAttack = z.infer<typeof ClientAttackSchema>
export type ClientFire = z.infer<typeof ClientFireSchema>
export type ClientReload = z.infer<typeof ClientReloadSchema>
export type ClientEquipArmor = z.infer<typeof ClientEquipArmorSchema>
export type ClientCraft = z.infer<typeof ClientCraftSchema>
export type ClientDrop = z.infer<typeof ClientDropSchema>
export type ClientPlace = z.infer<typeof ClientPlaceSchema>
export type ClientInvMove = z.infer<typeof ClientInvMoveSchema>
export type ClientHotbarSelect = z.infer<typeof ClientHotbarSelectSchema>
export type ClientPhysgun = z.infer<typeof ClientPhysgunSchema>
export type ClientTrust = z.infer<typeof ClientTrustSchema>
export type ClientConstraint = z.infer<typeof ClientConstraintSchema>
export type ClientConstraintRemove = z.infer<typeof ClientConstraintRemoveSchema>
export type ClientConsume = z.infer<typeof ClientConsumeSchema>
export type ClientDrink = z.infer<typeof ClientDrinkSchema>
export type ClientMarketOpen = z.infer<typeof ClientMarketOpenSchema>
export type ClientMarketBuy = z.infer<typeof ClientMarketBuySchema>
export type ClientMarketSell = z.infer<typeof ClientMarketSellSchema>
export type ClientJobAccept = z.infer<typeof ClientJobAcceptSchema>
export type ClientJobTurnIn = z.infer<typeof ClientJobTurnInSchema>
export type ClientContainerOpen = z.infer<typeof ClientContainerOpenSchema>
export type ClientContainerMove = z.infer<typeof ClientContainerMoveSchema>
export type ClientContainerSort = z.infer<typeof ClientContainerSortSchema>
export type ClientMessage = z.infer<typeof ClientMessageSchema>
