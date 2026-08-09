import type { ContentRegistry, WorldShape } from '@hobo/content'
import { EntityStore, ZoneIndex, type GameEntity, type MotionState } from '@hobo/gameplay'
import type { PersistenceStore } from '@hobo/persistence'
import { type BodyId, type PhysicsWorld, type ShapeDesc } from '@hobo/physics'
import { type EntityId, type Logger, type PlayerId, type Quat, type Vec3 } from '@hobo/shared'
export declare class GameWorld {
  readonly content: ContentRegistry
  readonly physics: PhysicsWorld
  private readonly log
  readonly entities: EntityStore
  readonly zones: ZoneIndex
  private readonly bodyByEntity
  private readonly entityByBody
  /** Entities whose props were settled last time we checked (sleep tracking). */
  private readonly settled
  /** Ids deleted since the last persistence flush. */
  private readonly deletedIds
  constructor(content: ContentRegistry, physics: PhysicsWorld, log: Logger)
  /** Static level geometry — mirrored by the client from the same world def. */
  private buildStaticWorld
  bodyOf(id: EntityId): BodyId | undefined
  entityOfBody(body: BodyId): GameEntity | undefined
  /** Spawns a physical prop entity (from placement, world seeding, or restore). */
  spawnProp(opts: {
    defId: string
    pos: Vec3
    rot: Quat
    motion: MotionState
    owner?: PlayerId
    id?: EntityId
  }): GameEntity
  /** Spawns a gatherable resource node (static, no physics interaction needed beyond blocking). */
  spawnResource(opts: {
    itemId: string
    pos: Vec3
    remaining: number
    perUse: number
    id?: EntityId
  }): GameEntity
  despawn(id: EntityId): void
  setPropMotion(entity: GameEntity, motion: MotionState): void
  /**
   * Post-physics sync: copy transforms of awake dynamic props back into
   * entity records, mark persistence-dirty, and detect settle transitions.
   * Settled props cost nothing here — the sleep system in action.
   */
  syncFromPhysics(events: {
    onSettle?: (e: GameEntity) => void
    onWake?: (e: GameEntity) => void
  }): {
    awake: number
    settledCount: number
  }
  isSettledEntity(id: EntityId): boolean
  /** First boot: seed initial world content. Afterwards the DB is authoritative. */
  seedOrRestore(store: PersistenceStore): void
  private restoreEntity
  /** Batched dirty write-out. Returns number of rows written. */
  flushDirty(store: PersistenceStore): number
}
export declare function toShapeDesc(shape: WorldShape): ShapeDesc
//# sourceMappingURL=gameWorld.d.ts.map
