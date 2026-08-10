import type {
  ClientCraft,
  ClientDrop,
  ClientInvMove,
  ClientUse,
  ClientWeld,
  ServerActionResult,
} from '@hobo/protocol'
import type { GameEntity, LevelUp } from '@hobo/gameplay'
import type { ItemDef } from '@hobo/content'
import type { GameWorld } from './gameWorld.js'
import { type PlayerSession } from './playerSession.js'
export type ActionOutcome = ServerActionResult
/** The tool capability of the session's active hotbar item, if any. */
export declare function equippedTool(
  session: PlayerSession,
): NonNullable<ItemDef['tool']> | undefined
export interface GatherResult {
  outcome: ActionOutcome
  /** Entity whose remaining count changed (for replication), if any. */
  changed: GameEntity | null
  /** Entity picked up and removed from the world, if any. */
  pickedUp: GameEntity | null
  /** Entity spawned as a side effect (felled tree trunk), if any. */
  spawned: GameEntity | null
  levelUps: LevelUp[]
  xpChanged: boolean
}
/**
 * Gathering: E-use for hand nodes, tool swings for gated nodes. The node
 * type (content) decides tool requirements, yield, XP and respawn.
 */
export declare function handleUse(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientUse,
  nowMs: number,
  canManipulate: (entity: GameEntity) => boolean,
): GatherResult
export declare function handleCraft(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientCraft,
  tick: number,
  tickRate: number,
): ActionOutcome
export declare function nearbyWorkstationKinds(
  session: PlayerSession,
  world: GameWorld,
): ReadonlySet<string>
export declare function handleDrop(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientDrop,
): {
  outcome: ActionOutcome
  droppedId: string | null
}
export interface WeldOutcome {
  outcome: ActionOutcome
  welded: {
    a: GameEntity
    b: GameEntity
  } | null
}
/** Weld two props (constraint tools — no player-facing trigger yet). */
export declare function handleWeld(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientWeld,
  canManipulate: (entity: GameEntity) => boolean,
): WeldOutcome
export declare function handleInvMove(session: PlayerSession, msg: ClientInvMove): ActionOutcome
//# sourceMappingURL=interactions.d.ts.map
