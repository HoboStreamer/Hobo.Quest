import { type Logger } from '@hobo/shared'
import type { GameEntity } from '@hobo/gameplay'
import type { GameWorld } from './gameWorld.js'
/**
 * Generic world events: one server-owned lifecycle —
 * scheduled → announced → active → completed/failed → cleanup —
 * with type handlers plugged in as data + callbacks. Supply drops moved
 * here from hardcoded server logic; extraction is the second citizen.
 * Event state is deliberately ephemeral: a restart cancels the party.
 */
export type EventPhase = 'scheduled' | 'announced' | 'active' | 'done'
export interface WorldEvent {
  id: string
  type: string
  x: number
  z: number
  phase: EventPhase
  /** Phase transition times (epoch ms). */
  announceAt: number
  activeAt: number
  endsAt: number
  /** Type-specific runtime state. */
  data: Record<string, unknown>
}
export interface EventHooks {
  announce(text: string): void
  announceTo(playerEntityId: string, text: string): void
  /** Players currently inside a circle: [entityId, distance][] */
  playersIn(
    x: number,
    z: number,
    radius: number,
  ): {
    entityId: string
    alive: boolean
  }[]
  /** Secure a player's carried valuables + recall them to the city. */
  extractPlayer(entityId: string): void
  broadcastSpawn(entity: GameEntity): void
  broadcastDespawn(id: string): void
}
export declare class EventManager {
  private readonly world
  private readonly hooks
  private readonly intervalScale
  private readonly log
  private readonly events
  private readonly handlers
  private readonly nextSpawnAt
  constructor(world: GameWorld, hooks: EventHooks, intervalScale: number, log: Logger)
  private register
  get activeCount(): number
  /** 1 Hz driver. */
  tick(nowMs: number, playersOnline: number): void
  private supplyDropHandler
  private extractionHandler
}
//# sourceMappingURL=eventManager.d.ts.map
