import type { PersistenceStore } from '@hobo/persistence'
import { type ClientMessage } from '@hobo/protocol'
import { type Logger } from '@hobo/shared'
import type { ServerConfig } from '../config.js'
import type { ServerMetrics } from '../observability/metrics.js'
import type { GameWorld } from './gameWorld.js'
import { type PlayerSession } from './playerSession.js'
/** A network connection as the game sees it — transport-agnostic. */
export interface GameConnection {
  /** Real client IP (Cloudflare-aware) — guest identity hangs off this. */
  ip: string
  send(text: string): void
  close(code: number, reason: string): void
}
export declare class GameServer {
  private readonly config
  private readonly world
  private readonly store
  private readonly metrics
  private readonly log
  private readonly sessions
  private readonly sessionsByConn
  private readonly sessionsByEntity
  private readonly playerBodies
  private readonly heldEntityIds
  /** Short-lived cache of OFFLINE owners' friend lists (prop protection). */
  private readonly offlineFriendsCache
  private tick
  private readonly moveQueries
  /** Body excluded from the current movement sweep (the moving player's own). */
  private sweepSelf
  private lastFlushTick
  /** Authoritative world environment: clock, weather, temperature. */
  private readonly env
  constructor(
    config: ServerConfig,
    world: GameWorld,
    store: PersistenceStore,
    metrics: ServerMetrics,
    log: Logger,
  )
  get currentTick(): number
  /**
   * Prop protection: world props (no owner) are free; otherwise the owner
   * or anyone the OWNER trusts may manipulate. Works for offline owners via
   * a TTL-cached repository lookup.
   */
  private canManipulate
  onMessage(conn: GameConnection, msg: ClientMessage): void
  /** Range + prop-protection gate shared by all container operations. */
  private containerAccessDenied
  private sendContainer
  /** Live supply crate (one at a time), plus its expiry tick. */
  private supplyCrateId
  private supplyExpiresTick
  private nextDropTick
  /**
   * Extraction events v1: every few minutes a supply crate lands at a random
   * wilderness site, announced to everyone. First to loot it wins; the
   * crate despawns once emptied (or after 6 minutes).
   */
  private tickSupplyDrops
  private timeWire
  onDisconnect(conn: GameConnection): void
  private handleHello
  private handlePhysgun
  private handleTrust
  private sendFriends
  /** One grab attempt down the view ray; latches + broadcasts on success. */
  private attemptGrab
  private releaseHeld
  /** Melee swing on another player: range + zone PvP rules + tool damage. */
  private handleMelee
  /**
   * Melee swing on a damageable prop: range + zone build rules + the same
   * stamina/cooldown economics as PvP. Structures are only destructible
   * where building is legal (safe city props are untouchable).
   */
  private handlePropAttack
  /** Destruction: scatter salvage + stored contents as physical props. */
  private destroyProp
  /** Death/rescue respawn: back to the city with restored vitals. */
  private respawn
  private statsWire
  step(): void
  private stepSessionMovement
  private replicate
  flush(): void
  /** Full save on shutdown. */
  shutdown(): void
  private savePlayer
  private playerToDto
  private send
  private sendRaw
  private sendInventory
  private sendSkills
  private sendCraftState
  private broadcastAll
  private broadcastSpawn
  /** Constraint create/remove: tell every client that knows either prop. */
  private broadcastConstraintState
  private broadcastDespawn
  private broadcastToKnowing
  /** Live map edit: every client refetches and rebuilds its terrain. */
  broadcastMapReload(): void
  /** Exposes crafting context for the client-facing recipe availability (welcome-time). */
  workstationsNear(session: PlayerSession): ReadonlySet<string>
}
//# sourceMappingURL=gameServer.d.ts.map
