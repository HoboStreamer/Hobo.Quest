import type {
  ClientCraft,
  ClientInvMove,
  ClientPlace,
  ClientUse,
  ServerActionResult,
} from '@hobo/protocol'
import type { GameWorld } from './gameWorld.js'
import { type PlayerSession } from './playerSession.js'
export type ActionOutcome = ServerActionResult
/** Gathering from resource nodes (and future entity interactions). */
export declare function handleUse(
  session: PlayerSession,
  world: GameWorld,
  msg: ClientUse,
): {
  outcome: ActionOutcome
  despawned: boolean
  targetChanged: boolean
}
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
export declare function handleInvMove(session: PlayerSession, msg: ClientInvMove): ActionOutcome
//# sourceMappingURL=interactions.d.ts.map
