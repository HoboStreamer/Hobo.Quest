import type { GameEntity } from '@hobo/gameplay'
import type { GameWorld } from './gameWorld.js'
import { type PlayerSession } from './playerSession.js'
/**
 * Physgun mechanics, server-authoritative.
 *
 * A grabbed dynamic body is driven toward a target point on the player's
 * view ray using velocity control (not teleportation), so it interacts
 * honestly with the rest of the physics world. Rotation offsets accumulate
 * from client intent commands but are applied here.
 *
 * This module is one *interaction* built on generic pieces (raycast, motion
 * control, zone rules); constraint tools (weld, rope, ...) will be siblings,
 * not extensions of a Physgun class.
 */
export declare const PHYSGUN_MAX_RANGE = 8
export declare const PHYSGUN_MIN_DIST = 1
export declare const PHYSGUN_MAX_DIST = 10
export type PhysgunDeny = 'no_target' | 'not_allowed' | 'not_owner' | 'zone' | 'already_held'
export declare function tryGrab(
  session: PlayerSession,
  world: GameWorld,
  heldByOthers: ReadonlySet<string>,
  canManipulate: (entity: GameEntity) => boolean,
): GameEntity | PhysgunDeny
export declare function release(session: PlayerSession): void
export declare function adjustDistance(session: PlayerSession, delta: number): void
export declare function rotateHeld(
  session: PlayerSession,
  dyaw: number,
  dpitch: number,
  snap: boolean,
): void
/** Freezes the held prop in place (motion -> static) and releases the beam. */
export declare function freezeHeld(session: PlayerSession, world: GameWorld): GameEntity | null
/** Called each tick for sessions holding a prop: drives the body toward the view target. */
export declare function driveHeld(session: PlayerSession, world: GameWorld): void
//# sourceMappingURL=physgun.d.ts.map
