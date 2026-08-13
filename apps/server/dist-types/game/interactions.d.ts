import type {
  ClientConstraint,
  ClientCraft,
  ClientDrop,
  ClientInvMove,
  ClientPlace,
  ClientUse,
  ServerActionResult,
} from '@hobo/protocol'
import { type GameEntity, type LevelUp, type PlantContext } from '@hobo/gameplay'
import type { ItemDef } from '@hobo/content'
import type { ConstraintRecord, GameWorld } from './gameWorld.js'
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
  env?: PlantContext,
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
/**
 * Ghost-preview placement: the stack leaves the inventory and becomes a
 * DYNAMIC prop at the requested pose. Never frozen on spawn — if the
 * client lied about a clear spot, physics depenetration resolves it
 * honestly instead of leaving a teleported wall inside someone's head.
 */
export declare function handlePlace(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientPlace,
): {
  outcome: ActionOutcome
  placedId: string | null
}
export interface ConstraintOutcome {
  outcome: ActionOutcome
  created: ConstraintRecord | null
}
/**
 * Rigging tool: create a constraint between two props. Every field of the
 * request is hostile until proven otherwise — tool, targets, ownership,
 * reach, gap, zone, per-entity limits, skill level, materials and the
 * parameter space itself are all validated server-side.
 */
export declare function handleConstraint(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientConstraint,
  canManipulate: (entity: GameEntity) => boolean,
): ConstraintOutcome
export declare function handleInvMove(session: PlayerSession, msg: ClientInvMove): ActionOutcome
//# sourceMappingURL=interactions.d.ts.map
