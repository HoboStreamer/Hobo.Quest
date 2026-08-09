import type {
  ClientCraft,
  ClientInvMove,
  ClientPlace,
  ClientUse,
  ClientWeld,
  ServerActionResult,
} from '@hobo/protocol'
import { type GameEntity, type LevelUp } from '@hobo/gameplay'
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
export declare function handlePlace(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientPlace,
): {
  outcome: ActionOutcome
  placedId: string | null
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
