import type { ContentRegistry, WorldShape } from '@hobo/content'
import {
  ConstraintIslands,
  EntityStore,
  ZoneIndex,
  type ConstraintParams,
  type ConstraintType,
  type GameEntity,
  type MotionState,
} from '@hobo/gameplay'
import type { PersistenceStore } from '@hobo/persistence'
import { type BodyId, type ConstraintId, type PhysicsWorld, type ShapeDesc } from '@hobo/physics'
import { type EntityId, type Logger, type PlayerId, type Quat, type Vec3 } from '@hobo/shared'
export interface ConstraintRecord {
  id: string
  type: ConstraintType
  a: EntityId
  b: EntityId
  params: ConstraintParams
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
  private readonly constraintRecords
  private readonly constraintsByEntity
  private readonly constraintsDirty
  private readonly constraintsDeleted
  /** Connected-constraint structure tracking (metrics, group semantics). */
  readonly islands: ConstraintIslands<EntityId>
  constructor(content: ContentRegistry, physics: PhysicsWorld, log: Logger)
  /** Static level geometry — mirrored by the client from the same world def. */
  private buildStaticWorld
  private addStaticBody
  /** Live map save: bring map-authored static collision up to date. */
  reconcileMapStatics(): void
  private terrainBody
  private readonly mapTerrain
  private readonly mapStatics
  /** Trimesh bodies for the map's extra terrain patches (world-space verts). */
  private buildTerrainBody
  /** Live map edit: swap terrain + patch collision for the new map. */
  /**
   * Live map save: bring terrain collision up to date.
   *
   * This used to remove and recreate EVERY terrain body, so retinting one
   * surface rebuilt the collision for the whole map. The layer reconciles by
   * stable id and its signature covers only what collision depends on, so a
   * surface-only edit touches no body and a sculpt rebuilds exactly one.
   */
  reconcileMapTerrain(): void
  /** Live-apply diagnostics and tests: what the map layers currently hold. */
  mapStaticCount(): number
  mapTerrainCount(): number
  /** Cumulative map-layer body rebuilds, for churn assertions. */
  mapRebuildCount(): number
  mapZoneCount(): number
  bodyOf(id: EntityId): BodyId | undefined
  entityOfBody(body: BodyId): GameEntity | undefined
  spawnProp(opts: {
    defId: string
    pos: Vec3
    rot: Quat
    motion: MotionState
    owner?: PlayerId
    id?: EntityId
    /** Items recovered on pickup; every prop defaults to carrying itself. */
    lootCount?: number
    /** Initial toss velocity (dropping an item throws it forward). */
    velocity?: Vec3
    /** Initial spin (felled trees tip over). */
    angularVelocity?: Vec3
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
  /**
   * Swings a frozen door about its hinge edge (local -X). The whole pose
   * (position AND rotation) pivots so it reads as a real hinge, not a
   * center-spin. Returns false unless the prop is an installed (non-
   * dynamic) door.
   */
  toggleDoor(entity: GameEntity): boolean
  setPropMotion(entity: GameEntity, motion: MotionState): void
  /** True when a constraint of this type already links the pair. */
  hasConstraint(a: EntityId, b: EntityId, type: ConstraintType): boolean
  constraintCountFor(id: EntityId): number
  get constraintCount(): number
  /**
   * Creates a validated constraint between two props. Params must already
   * have passed `validateConstraintParams`; this maps them onto the physics
   * engine, indexes the record and marks it for persistence.
   */
  addConstraintRecord(
    a: GameEntity,
    b: GameEntity,
    type: ConstraintType,
    params: ConstraintParams,
    id?: string,
  ): ConstraintRecord | null
  /** Removes every constraint touching the entity; returns removed records. */
  removeConstraintsFor(entityId: EntityId): ConstraintRecord[]
  private removeConstraintRecord
  private indexConstraint
  allConstraints(): IterableIterator<ConstraintRecord>
  constraintsFor(entityId: EntityId): ConstraintRecord[]
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
  /**
   * Called after boot-restore and after every live map save: any editor-
   * placed resource node with no matching live resource nearby spawns.
   * (Removal is by harvesting in game — reconcile never deletes.)
   */
  /**
   * Live map save: bring map-authored resource nodes into line, BY IDENTITY.
   *
   * The previous rule was "a node of this type within a metre already
   * exists", which is not identity: two deliberately adjacent authored nodes
   * collapsed into one, and a moved seed spawned a duplicate instead of
   * moving. Every entity a map object authored carries that object's id, so
   * this can only ever touch what the map owns — a player's constructions
   * have no provenance and are never considered.
   *
   * Gameplay state is preserved across an unrelated save: a depleted node
   * stays depleted, because an admin retexturing a wall must not silently
   * restock the map.
   */
  reconcileMapNodes(): void
  /** Reposition an authored entity onto the terrain, body and all. */
  private placeAt
  /**
   * Apply the map's authored zones. Idempotent by construction: the map layer
   * is REPLACED, never appended, so saving the same map twice cannot stack
   * duplicate rule volumes the way merging into `content.world.zones` would.
   * The base content zones are untouched, so a map can add a restriction but
   * never lift one the world def declared.
   */
  reconcileMapZones(): void
  /**
   * Live map save: map-authored props, by identity.
   *
   * The old rule was "a prop of this item within two metres", so a player's
   * crate dropped beside an authored one suppressed the authored one — and a
   * player's constructions could be mistaken for map seeds. Props with no
   * provenance are never touched here.
   */
  reconcileMapProps(): void
  private seedResources
  private restoreEntity
  flushDirty(store: PersistenceStore): number
}
export declare function toShapeDesc(shape: WorldShape): ShapeDesc
//# sourceMappingURL=gameWorld.d.ts.map
