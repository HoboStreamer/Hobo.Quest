import { type NpcState, type PerceptionCandidate } from '@hobo/gameplay'
import type { PersistenceStore } from '@hobo/persistence'
import { type EntityId, type Logger } from '@hobo/shared'
import type { GameWorld } from './gameWorld.js'
import type { RegionTracker } from '@hobo/gameplay'
export interface NpcHooks {
  /** NPC melee lands on a player (id = player ENTITY id). */
  onAttackPlayer(npcEntityId: EntityId, playerEntityId: string, damage: number): void
  /** Sound events this second (gunshots, fights) for hearing. */
  soundsThisTick(): readonly {
    x: number
    z: number
  }[]
  /** Candidate actors near a point (players + hostile NPC logic later). */
  hostilesNear(x: number, z: number, radius: number, faction: string): PerceptionCandidate[]
}
export declare class NpcManager {
  private readonly world
  private readonly regions
  private readonly hooks
  private readonly log
  /** ALL NPC instances, materialized or not, by instance id. */
  private readonly states
  /** Materialized subset: instance id -> physics body. */
  private readonly bodies
  private readonly navigation
  private behaviorPhase
  constructor(world: GameWorld, regions: RegionTracker, hooks: NpcHooks, log: Logger)
  /** Boot: restore persisted NPCs, then seed content spawns not yet known. */
  seedOrRestore(store: PersistenceStore): void
  /** Counts for metrics: [full-sim, abstract]. */
  counts(): [number, number]
  npcStateOf(entityId: EntityId): NpcState | undefined
  /**
   * Damage an NPC (melee/ranged already mitigated upstream). Returns the
   * loot scattered on death, or null while it survives.
   */
  damage(entityId: EntityId, amount: number, nowMs: number): 'dead' | 'hurt' | null
  /** One simulation step; call every server tick. */
  step(nowMs: number, tick: number, tickRate: number): void
  /** Entity ids of materialized NPCs whose pose changed (for snapshots). */
  materializedIds(): IterableIterator<EntityId>
  private materialize
  private dematerialize
  private lineOfSight
  /** Persistence: NPCs write their ABSTRACT state (never bodies/entities). */
  flush(store: PersistenceStore, now: number): void
}
//# sourceMappingURL=npcManager.d.ts.map
