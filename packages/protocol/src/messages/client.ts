import { z } from 'zod'

/**
 * Client -> server messages, defined as zod schemas because the server must
 * treat every inbound byte as hostile. Types are inferred from schemas so
 * validation and typing can never drift apart.
 */

const vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])

export const ClientHelloSchema = z.object({
  t: z.literal('hello'),
  v: z.number().int(),
  /** Persistent identity token (localStorage). Replaced by real auth later. */
  token: z.string().min(8).max(64),
  name: z.string().min(1).max(24),
})

/**
 * One input command per simulation tick. The client sends these at tick rate;
 * `seq` is echoed in snapshots for prediction reconciliation. The server
 * validates command counts to prevent speedup, and simulates movement itself —
 * the client never reports a position.
 */
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

export const ClientCraftSchema = z.object({
  t: z.literal('craft'),
  recipe: z.string().max(64),
})

/** Place the placeable item currently in the given inventory slot. */
export const ClientPlaceSchema = z.object({
  t: z.literal('place'),
  slot: z.number().int().nonnegative().max(255),
  pos: vec3,
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
    /** Snap rotation to 15-degree increments (precision mode). */
    snap: z.boolean().optional(),
  }),
  z.object({ t: z.literal('physgun'), a: z.literal('freeze') }),
  z.object({ t: z.literal('physgun'), a: z.literal('unfreeze'), target: z.string().max(32) }),
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

/** Weld two props (constraint tools — no player-facing UX yet). */
export const ClientWeldSchema = z.object({
  t: z.literal('weld'),
  a: z.string().max(32),
  b: z.string().max(32),
})

/** Remove all welds touching the target prop. */
export const ClientUnweldSchema = z.object({
  t: z.literal('unweld'),
  target: z.string().max(32),
})

export const ClientMessageSchema = z.union([
  ClientHelloSchema,
  ClientInputSchema,
  ClientUseSchema,
  ClientCraftSchema,
  ClientPlaceSchema,
  ClientInvMoveSchema,
  ClientHotbarSelectSchema,
  ClientPhysgunSchema,
  ClientTrustSchema,
  ClientWeldSchema,
  ClientUnweldSchema,
])

export type ClientHello = z.infer<typeof ClientHelloSchema>
export type ClientInput = z.infer<typeof ClientInputSchema>
export type ClientUse = z.infer<typeof ClientUseSchema>
export type ClientCraft = z.infer<typeof ClientCraftSchema>
export type ClientPlace = z.infer<typeof ClientPlaceSchema>
export type ClientInvMove = z.infer<typeof ClientInvMoveSchema>
export type ClientHotbarSelect = z.infer<typeof ClientHotbarSelectSchema>
export type ClientPhysgun = z.infer<typeof ClientPhysgunSchema>
export type ClientTrust = z.infer<typeof ClientTrustSchema>
export type ClientWeld = z.infer<typeof ClientWeldSchema>
export type ClientUnweld = z.infer<typeof ClientUnweldSchema>
export type ClientMessage = z.infer<typeof ClientMessageSchema>
