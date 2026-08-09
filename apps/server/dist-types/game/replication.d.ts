import type { GameEntity } from '@hobo/gameplay'
import type { ServerSnapshot, WireEntity, WirePlayerState } from '@hobo/protocol'
import { type EntityId } from '@hobo/shared'
import type { GameWorld } from './gameWorld.js'
import type { PlayerSession } from './playerSession.js'
/**
 * Interest management + snapshot building.
 *
 * Relevance is currently a radius test over the entity store (fine at slice
 * scale). The contract to preserve as the world grows: replication cost per
 * client is proportional to *relevant* entities, never total entities — the
 * radius query will move to the spatial region index without changing
 * callers.
 */
export declare function wireEntityFor(world: GameWorld, entity: GameEntity): WireEntity
export declare function wirePlayerFor(session: PlayerSession): WirePlayerState
export interface InterestDiff {
  entered: GameEntity[]
  left: EntityId[]
}
/** Updates session.known in place and returns what changed. */
export declare function updateInterest(
  session: PlayerSession,
  world: GameWorld,
  radius: number,
): InterestDiff
/** Snapshot for one session: relevant players + awake relevant prop bodies. */
export declare function buildSnapshot(
  session: PlayerSession,
  world: GameWorld,
  sessions: Iterable<PlayerSession>,
  tick: number,
): ServerSnapshot
//# sourceMappingURL=replication.d.ts.map
