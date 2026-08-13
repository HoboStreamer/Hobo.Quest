import { RegionTracker } from '@hobo/gameplay'
import type { PersistenceStore } from '@hobo/persistence'
import { type ClientMessage } from '@hobo/protocol'
import { type Logger } from '@hobo/shared'
import type { ServerConfig } from '../config.js'
import type { ServerMetrics } from '../observability/metrics.js'
import type { GameWorld } from './gameWorld.js'
import { type PlayerSession } from './playerSession.js'
import { NpcManager } from './npcManager.js'
import { EventManager } from './eventManager.js'
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
  /** Coarse activation regions (NPC LOD and event relevance hang off this). */
  readonly regions: RegionTracker
  /** Server-authoritative NPC simulation (LOD-aware). */
  readonly npcs: NpcManager
  /** Generic world events (supply drops, extraction). */
  readonly events: EventManager
  /** Players who recently attacked someone (defensive NPCs respond). */
  private readonly aggro
  /** Sound events (gunshots, fights) accumulated for NPC hearing. */
  private sounds
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
  /** Live sell-stock per market: item -> remaining + next restock time. */
  private readonly marketStock
  /** Lazily restocked stock entry for one market sell line. */
  private stockOf
  private persistMarkets
  /**
   * Market interactions: open/buy/sell against the market a shop prop
   * references. Everything server-atomic: proximity, faction stance,
   * live stock, coins and space all validated here.
   */
  private handleMarket
  /** Contract accept/turn-in at a trading post. */
  private handleJob
  private sendJobs
  private sendReputation
  /** Range + prop-protection gate shared by all container operations. */
  private containerAccessDenied
  private sendContainer
  private timeWire
  /**
   * Utility + production sweep, once a second over prop entities. Plants
   * stay timestamp-lazy (a slower cadence touches them); machines and
   * generators are few, and their jobs are timestamp-based too — this
   * sweep only notices completions/starts, it never simulates.
   */
  private tickProduction
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
   * Ranged fire: the client sent pure intent — the shot leaves the
   * player's AUTHORITATIVE eye along their AUTHORITATIVE view (from
   * movement inputs) plus server-rolled spread. Magazine, cadence and
   * reload state live in the weapon stack's meta and are validated here.
   */
  private handleFire
  /**
   * The one place player damage lands: armor mitigation (with durability
   * wear), wound statuses, death handling, and hit feedback. Melee, bullets
   * and future explosions all converge here.
   */
  private damagePlayer
  /**
   * Melee swing on a damageable prop: range + zone build rules + the same
   * stamina/cooldown economics as PvP. Structures are only destructible
   * where building is legal (safe city props are untouchable).
   */
  private handlePropAttack
  /** Melee swing on an NPC: reach + the shared stamina economics. */
  private handleNpcAttack
  /** NPC damage sink: aggro marking, death, loot scatter, feedback. */
  private applyNpcDamage
  /** Damage application for props: resistance, destruction, feedback.
   * Returns false when the prop has no health capability. */
  private applyPropDamage
  /** Destruction: scatter salvage + stored contents as physical props. */
  private destroyProp
  /**
   * Extraction success: carried valuables become SECURED (they no longer
   * drop on death) and the player is recalled to the safe city.
   */
  private extractPlayer
  /** E on a chassis: mount a valid assembly, or dismount if driving it. */
  private handleVehicleUse
  private dismount
  /**
   * Vehicle drive: intent (WASD) becomes thrust force + steering on the
   * chassis body; wheels roll on their rigged bearings; fuel burns from
   * the trunk like a generator. The rider is carried kinematically.
   */
  private driveVehicle
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
