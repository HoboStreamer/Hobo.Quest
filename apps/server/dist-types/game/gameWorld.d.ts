import type { ContentRegistry, WorldShape } from '@hobo/content'
import { EntityStore, ZoneIndex, type GameEntity, type MotionState } from '@hobo/gameplay'
import type { PersistenceStore } from '@hobo/persistence'
import { type BodyId, type ConstraintId, type PhysicsWorld, type ShapeDesc } from '@hobo/physics'
import { type EntityId, type Logger, type PlayerId, type Quat, type Vec3 } from '@hobo/shared'
interface WeldRecord {
  id: string
  a: EntityId
  b: EntityId
  physId: ConstraintId
}
export declare class GameWorld {
  readonly content: ContentRegistry
  readonly physics: PhysicsWorld
  private readonly log
  readonly entities: EntityStore
  readonly zones: ZoneIndex
  private readonly bodyByEntity
  private readonly entityByBody
  private readonly settled
  private readonly deletedIds
  private readonly welds
  private readonly weldsByEntity
  private readonly weldsDirty
  private readonly weldsDeleted
  constructor(content: ContentRegistry, physics: PhysicsWorld, log: Logger)
  /** Static level geometry — mirrored by the client from the same world def. */
  private buildStaticWorld
  bodyOf(id: EntityId): BodyId | undefined
  entityOfBody(body: BodyId): GameEntity | undefined
  spawnProp(opts: {
    defId: string
    pos: Vec3
    rot: Quat
    motion: MotionState
    owner?: PlayerId
    id?: EntityId
  }): GameEntity
  /** Spawns a resource node instance of a content-defined node type. */
  spawnResource(opts: {
    nodeTypeId: string
    pos: Vec3
    remaining: number
    depletedUntil?: number
    id?: EntityId
  }): GameEntity
  despawn(id: EntityId): void
  setPropMotion(entity: GameEntity, motion: MotionState): void
  hasWeld(a: EntityId, b: EntityId): boolean
  weldCountFor(id: EntityId): number
  addWeld(a: GameEntity, b: GameEntity, id?: string): WeldRecord | null
  /** Removes every weld touching the entity; returns the removed records. */
  removeWeldsFor(entityId: EntityId): WeldRecord[]
  private indexWeld
  allWelds(): IterableIterator<WeldRecord>
  /** Refills depleted nodes whose respawn time passed. Returns refilled entities. */
  respawnDueResources(nowMs: number): GameEntity[]
  syncFromPhysics(events: {
    onSettle?: (e: GameEntity) => void
    onWake?: (e: GameEntity) => void
  }): {
    awake: number
    settledCount: number
  }
  isSettledEntity(id: EntityId): boolean
  seedOrRestore(store: PersistenceStore): void
  private seedProps
  private seedResources
  private restoreEntity
  flushDirty(store: PersistenceStore): number
}
export declare function toShapeDesc(shape: WorldShape): ShapeDesc
export {}
//# sourceMappingURL=gameWorld.d.ts.map
