import type { PersistenceStore } from '@hobo/persistence'
import { type ClientMessage } from '@hobo/protocol'
import { type Logger } from '@hobo/shared'
import type { ServerConfig } from '../config.js'
import type { ServerMetrics } from '../observability/metrics.js'
import type { GameWorld } from './gameWorld.js'
import { type PlayerSession } from './playerSession.js'
/** A network connection as the game sees it — transport-agnostic. */
export interface GameConnection {
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
  private readonly playerBodies
  private readonly heldEntityIds
  private tick
  private readonly moveQueries
  private lastFlushTick
  constructor(
    config: ServerConfig,
    world: GameWorld,
    store: PersistenceStore,
    metrics: ServerMetrics,
    log: Logger,
  )
  get currentTick(): number
  onMessage(conn: GameConnection, msg: ClientMessage): void
  onDisconnect(conn: GameConnection): void
  private handleHello
  private handlePhysgun
  private releaseHeld
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
  private sendCraftState
  private broadcastAll
  private broadcastSpawn
  private broadcastDespawn
  private broadcastToKnowing
  /** Exposes crafting context for the client-facing recipe availability (welcome-time). */
  workstationsNear(session: PlayerSession): ReadonlySet<string>
}
//# sourceMappingURL=gameServer.d.ts.map
