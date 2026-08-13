import {
  buildTerrainGrid,
  getMapOverride,
  terrainHeight,
  worldSpawn,
  effectiveShape,
} from '@hobo/content'
import type {
  ContentRegistry,
  MapNodeSpawn,
  MapPropSpawn,
  StaticBody,
  WorldShape,
} from '@hobo/content'
import {
  ConstraintIslands,
  EntityStore,
  SpatialHash,
  ZoneIndex,
  migrateLegacyPlant,
  validateConstraintParams,
  type ConstraintParams,
  type ConstraintType,
  type GameEntity,
  type MotionState,
} from '@hobo/gameplay'
import type { ConstraintDto, PersistenceStore, WorldEntityDto } from '@hobo/persistence'
import { MapStaticLayer } from './mapStaticLayer.js'
import { MapTerrainLayer } from './mapTerrainLayer.js'
import { planMapProvenance, provenanceState, readProvenance } from './mapProvenance.js'
import {
  CollisionLayer,
  type BodyId,
  type ConstraintDesc,
  type ConstraintId,
  type PhysicsWorld,
  type ShapeDesc,
} from '@hobo/physics'
import {
  newEntityId,
  newUid,
  qfromEuler,
  qfromYaw,
  quat,
  vec3,
  type EntityId,
  type Logger,
  type PlayerId,
  type Quat,
  type Vec3,
  qmul,
  qnormalize,
  qrotateVec,
} from '@hobo/shared'

/**
 * Authoritative world state: the entity store, its physical counterparts,
 * constraints between entities, and the mapping to persistence DTOs.
 * Physics bodies and entity records are runtime-only; the store is rebuilt
 * from DTOs on boot.
 */

const PROP_COLLIDES = CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player

export interface ConstraintRecord {
  id: string
  type: ConstraintType
  a: EntityId
  b: EntityId
  params: ConstraintParams
  physId: ConstraintId
}

export class GameWorld {
  readonly entities = new EntityStore()
  readonly zones: ZoneIndex
  private readonly bodyByEntity = new Map<EntityId, BodyId>()
  private readonly entityByBody = new Map<BodyId, EntityId>()
  private readonly settled = new Set<EntityId>()
  private readonly deletedIds = new Set<EntityId>()

  private readonly constraintRecords = new Map<string, ConstraintRecord>()
  private readonly constraintsByEntity = new Map<EntityId, Set<string>>()
  private readonly constraintsDirty = new Set<string>()
  private readonly constraintsDeleted = new Set<string>()
  /** Connected-constraint structure tracking (metrics, group semantics). */
  readonly islands = new ConstraintIslands<EntityId>()
  /**
   * THE spatial index: every entity (props, resources, players) by ground
   * position. Interest queries, workstation/shop lookups, sprinkler and
   * power coupling, and NPC perception all consume this one structure.
   * GameWorld maintains props/resources; the server maintains players.
   */
  readonly spatial = new SpatialHash<EntityId>(16)

  constructor(
    readonly content: ContentRegistry,
    readonly physics: PhysicsWorld,
    private readonly log: Logger,
  ) {
    this.zones = new ZoneIndex(content.world.zones)
    this.mapStatics = new MapStaticLayer(physics)
    this.mapTerrain = new MapTerrainLayer(physics)
    this.reconcileMapZones()
    this.buildStaticWorld()
  }

  /** Static level geometry — mirrored by the client from the same world def. */
  private buildStaticWorld(): void {
    const world = this.content.world
    // Safety floor beneath the terrain (catches anything that tunnels).
    this.physics.addBody({
      shape: { type: 'box', size: [world.groundHalfExtent * 2, 1, world.groundHalfExtent * 2] },
      motion: 'static',
      pos: vec3(0, -2.0, 0),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
    // Heightfield terrain — the SAME grid the client builds for prediction
    // and rendering (see @hobo/content buildTerrainGrid).
    this.terrainBody = this.buildTerrainBody()
    this.mapTerrain.reconcile(getMapOverride()?.terrains ?? [])
    // Invisible boundary walls: past the terrain edge there is only ocean
    // and an endless fall — the island's edge is the end of the world.
    const b = world.groundHalfExtent + 0.5
    const wallLen = b * 2 + 4
    for (const [px, pz, sx, sz] of [
      [0, b, wallLen, 1],
      [0, -b, wallLen, 1],
      [b, 0, 1, wallLen],
      [-b, 0, 1, wallLen],
    ] as const) {
      this.physics.addBody({
        shape: { type: 'box', size: [sx, 30, sz] },
        motion: 'static',
        pos: vec3(px, 10, pz),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
      })
    }
    for (const s of world.statics) this.addStaticBody(s)
    this.reconcileMapStatics()
  }

  private addStaticBody(s: StaticBody): BodyId {
    return this.physics.addBody({
      shape: toShapeDesc(effectiveShape(s)),
      motion: 'static',
      pos: vec3(s.pos[0], s.pos[1], s.pos[2]),
      rot: s.rot ? qfromEuler(quat(), s.rot[0], s.rot[1], s.rot[2]) : qfromYaw(quat(), s.yaw),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }

  /** Live map save: bring map-authored static collision up to date. */
  reconcileMapStatics(): void {
    this.mapStatics.reconcile(getMapOverride()?.statics ?? [])
  }

  private terrainBody: BodyId | null = null
  private readonly mapTerrain: MapTerrainLayer
  private readonly mapStatics: MapStaticLayer

  /** Trimesh bodies for the map's extra terrain patches (world-space verts). */
  private buildTerrainBody(): BodyId | null {
    if (getMapOverride()) return null
    const grid = buildTerrainGrid(this.content.world)
    return this.physics.addBody({
      shape: { type: 'trimesh', positions: grid.positions, indices: grid.indices },
      motion: 'static',
      pos: vec3(0, 0, 0),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }

  /** Live map edit: swap terrain + patch collision for the new map. */
  /**
   * Live map save: bring terrain collision up to date.
   *
   * This used to remove and recreate EVERY terrain body, so retinting one
   * surface rebuilt the collision for the whole map. The layer reconciles by
   * stable id and its signature covers only what collision depends on, so a
   * surface-only edit touches no body and a sculpt rebuilds exactly one.
   */
  reconcileMapTerrain(): void {
    // The base world's procedural collider exists only when there is no map;
    // whether one is loaded can change between saves.
    const wantBase = getMapOverride() === null
    if (!wantBase && this.terrainBody !== null) {
      this.physics.removeBody(this.terrainBody)
      this.terrainBody = null
    } else if (wantBase && this.terrainBody === null) {
      this.terrainBody = this.buildTerrainBody()
    }
    this.mapTerrain.reconcile(getMapOverride()?.terrains ?? [])
  }

  /** Live-apply diagnostics and tests: what the map layers currently hold. */
  mapStaticCount(): number {
    return this.mapStatics.size
  }

  mapTerrainCount(): number {
    return this.mapTerrain.size
  }

  /** Cumulative map-layer body rebuilds, for churn assertions. */
  mapRebuildCount(): number {
    return this.mapStatics.rebuilds + this.mapTerrain.rebuilds
  }

  mapZoneCount(): number {
    return this.zones.all().length - this.content.world.zones.length
  }

  bodyOf(id: EntityId): BodyId | undefined {
    return this.bodyByEntity.get(id)
  }

  entityOfBody(body: BodyId): GameEntity | undefined {
    const id = this.entityByBody.get(body)
    return id ? this.entities.get(id) : undefined
  }

  /** NPC bodies register here so rays/attacks resolve to their entity. */
  registerNpcBody(body: BodyId, entityId: EntityId): void {
    this.entityByBody.set(body, entityId)
    this.bodyByEntity.set(entityId, body)
  }

  unregisterNpcBody(body: BodyId): void {
    const id = this.entityByBody.get(body)
    this.entityByBody.delete(body)
    if (id !== undefined) this.bodyByEntity.delete(id)
  }

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
  }): GameEntity {
    const rep = this.content.worldRepOf(opts.defId)
    const entity: GameEntity = {
      id: opts.id ?? newEntityId(),
      kind: 'prop',
      transform: { pos: { ...opts.pos }, rot: { ...opts.rot } },
      prop: {
        defId: opts.defId,
        motion: opts.motion,
        lootCount: opts.lootCount ?? 1,
        ...(this.content.item(opts.defId)?.container
          ? {
              container: new Array<null>(this.content.item(opts.defId)!.container!.slots).fill(
                null,
              ) as ({ defId: string; count: number } | null)[],
            }
          : {}),
      },
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      persistent: true,
      dirty: true,
    }
    this.entities.add(entity)
    this.spatial.insert(entity.id, opts.pos.x, opts.pos.z)
    const bodyId = this.physics.addBody({
      shape: toShapeDesc(rep.shape),
      motion: opts.motion === 'dynamic' ? 'dynamic' : 'static',
      pos: opts.pos,
      rot: opts.rot,
      massKg: rep.massKg,
      layer: CollisionLayer.Prop,
      collidesWith: PROP_COLLIDES,
    })
    if (opts.velocity && opts.motion === 'dynamic') {
      this.physics.setLinearVelocity(bodyId, opts.velocity)
    }
    if (opts.angularVelocity && opts.motion === 'dynamic') {
      this.physics.setAngularVelocity(bodyId, opts.angularVelocity)
    }
    this.bodyByEntity.set(entity.id, bodyId)
    this.entityByBody.set(bodyId, entity.id)
    return entity
  }

  /** Spawns a resource node instance of a content-defined node type. */
  spawnResource(opts: {
    nodeTypeId: string
    pos: Vec3
    remaining: number
    depletedUntil?: number
    id?: EntityId
  }): GameEntity {
    const nodeType = this.content.nodeTypeOrThrow(opts.nodeTypeId)
    const entity: GameEntity = {
      id: opts.id ?? newEntityId(),
      kind: 'resource',
      transform: { pos: { ...opts.pos }, rot: quat() },
      resource: {
        nodeTypeId: opts.nodeTypeId,
        remaining: opts.remaining,
        depletedUntil: opts.depletedUntil ?? 0,
      },
      persistent: true,
      dirty: true,
    }
    this.entities.add(entity)
    this.spatial.insert(entity.id, opts.pos.x, opts.pos.z)
    const bodyId = this.physics.addBody({
      shape: toShapeDesc(nodeType.bodyShape),
      motion: 'static',
      pos: vec3(opts.pos.x, opts.pos.y + nodeType.bodyOffsetY, opts.pos.z),
      layer: CollisionLayer.Prop,
      collidesWith: CollisionLayer.Player,
    })
    this.bodyByEntity.set(entity.id, bodyId)
    this.entityByBody.set(bodyId, entity.id)
    return entity
  }

  despawn(id: EntityId): void {
    const entity = this.entities.remove(id)
    if (!entity) return
    this.spatial.remove(id)
    this.removeConstraintsFor(id)
    const bodyId = this.bodyByEntity.get(id)
    if (bodyId !== undefined) {
      this.physics.removeBody(bodyId)
      this.bodyByEntity.delete(id)
      this.entityByBody.delete(bodyId)
    }
    this.settled.delete(id)
    if (entity.persistent) this.deletedIds.add(id)
  }

  /**
   * Swings a frozen door about its hinge edge (local -X). The whole pose
   * (position AND rotation) pivots so it reads as a real hinge, not a
   * center-spin. Returns false unless the prop is an installed (non-
   * dynamic) door.
   */
  toggleDoor(entity: GameEntity): boolean {
    const def = entity.prop ? this.content.item(entity.prop.defId) : undefined
    if (!entity.prop || !def?.door || entity.prop.motion === 'dynamic') return false
    const bodyId = this.bodyByEntity.get(entity.id)
    if (bodyId === undefined) return false
    const width = def.world?.shape.type === 'box' ? def.world.shape.size[0] : 1
    const opening = !entity.prop.doorOpen
    const angle = def.door.openAngle * (opening ? 1 : -1)
    const rot = entity.transform.rot
    const pos = entity.transform.pos
    // Hinge point: door-local (-w/2, 0, 0) in world space.
    const hingeLocal = vec3(-width / 2, 0, 0)
    const hingeOff = qrotateVec(vec3(), rot, hingeLocal)
    const hinge = vec3(pos.x + hingeOff.x, pos.y + hingeOff.y, pos.z + hingeOff.z)
    const spin = qfromYaw(quat(), angle)
    // New rotation, then re-place the center so the hinge stays fixed.
    qmul(rot, spin, rot)
    qnormalize(rot, rot)
    const newOff = qrotateVec(vec3(), rot, hingeLocal)
    pos.x = hinge.x - newOff.x
    pos.y = hinge.y - newOff.y
    pos.z = hinge.z - newOff.z
    entity.prop.doorOpen = opening
    entity.dirty = true
    this.physics.setTransform(bodyId, pos, rot)
    return true
  }

  setPropMotion(entity: GameEntity, motion: MotionState): void {
    if (!entity.prop) return
    const bodyId = this.bodyByEntity.get(entity.id)
    if (bodyId === undefined) return
    entity.prop.motion = motion
    entity.dirty = true
    this.spatial.move(entity.id, entity.transform.pos.x, entity.transform.pos.z)
    this.physics.setMotionType(bodyId, motion === 'dynamic' ? 'dynamic' : 'static')
    if (motion === 'dynamic') this.settled.delete(entity.id)
  }

  // ── Constraints ────────────────────────────────────────────────────

  /** True when a constraint of this type already links the pair. */
  hasConstraint(a: EntityId, b: EntityId, type: ConstraintType): boolean {
    const set = this.constraintsByEntity.get(a)
    if (!set) return false
    for (const id of set) {
      const rec = this.constraintRecords.get(id)
      if (rec && rec.type === type && (rec.b === b || rec.a === b)) return true
    }
    return false
  }

  constraintCountFor(id: EntityId): number {
    return this.constraintsByEntity.get(id)?.size ?? 0
  }

  /** A weld/hinge/axis/slider/motor (collision-off joint) links the pair. */
  private pairHasRigidJoint(a: EntityId, b: EntityId): boolean {
    const set = this.constraintsByEntity.get(a)
    if (!set) return false
    for (const id of set) {
      const rec = this.constraintRecords.get(id)
      if (!rec || (rec.a !== b && rec.b !== b)) continue
      if (rec.type !== 'rope' && rec.type !== 'spring') return true
    }
    return false
  }

  get constraintCount(): number {
    return this.constraintRecords.size
  }

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
  ): ConstraintRecord | null {
    const bodyA = this.bodyByEntity.get(a.id)
    const bodyB = this.bodyByEntity.get(b.id)
    if (bodyA === undefined || bodyB === undefined) return null
    const desc = toPhysicsConstraint(type, params, bodyA, bodyB)
    if (!desc) return null
    // Mixed collision flags between one pair are explosive: a weld holds
    // the bodies overlapped while a rope's contact solver fights to push
    // them apart, and cutting releases the stored energy as a launch. Any
    // rigid joint on the pair turns the soft joint's collision off.
    if ((desc.type === 'rope' || desc.type === 'spring') && this.pairHasRigidJoint(a.id, b.id)) {
      desc.collision = false
    }
    const physId = this.physics.addConstraint(desc)
    const record: ConstraintRecord = {
      id: id ?? newUid(),
      type,
      a: a.id,
      b: b.id,
      params,
      physId,
    }
    this.constraintRecords.set(record.id, record)
    this.indexConstraint(record.a, record.id)
    this.indexConstraint(record.b, record.id)
    this.islands.addEdge(record.id, record.a, record.b)
    this.constraintsDirty.add(record.id)
    this.settled.delete(a.id)
    this.settled.delete(b.id)
    return record
  }

  /** Removes every constraint touching the entity; returns removed records. */
  removeConstraintsFor(entityId: EntityId): ConstraintRecord[] {
    const ids = this.constraintsByEntity.get(entityId)
    if (!ids || ids.size === 0) return []
    const removed: ConstraintRecord[] = []
    for (const id of [...ids]) {
      const rec = this.constraintRecords.get(id)
      if (!rec) continue
      this.removeConstraintRecord(rec)
      removed.push(rec)
    }
    return removed
  }

  private removeConstraintRecord(rec: ConstraintRecord): void {
    this.physics.removeConstraint(rec.physId)
    this.constraintRecords.delete(rec.id)
    this.constraintsByEntity.get(rec.a)?.delete(rec.id)
    this.constraintsByEntity.get(rec.b)?.delete(rec.id)
    this.islands.removeEdge(rec.id)
    this.constraintsDirty.delete(rec.id)
    this.constraintsDeleted.add(rec.id)
    // The freed bodies must re-settle on their own merits.
    this.settled.delete(rec.a)
    this.settled.delete(rec.b)
    const bodyA = this.bodyByEntity.get(rec.a)
    const bodyB = this.bodyByEntity.get(rec.b)
    if (bodyA !== undefined) this.physics.wake(bodyA)
    if (bodyB !== undefined) this.physics.wake(bodyB)
  }

  private indexConstraint(entityId: EntityId, constraintId: string): void {
    let set = this.constraintsByEntity.get(entityId)
    if (!set) {
      set = new Set()
      this.constraintsByEntity.set(entityId, set)
    }
    set.add(constraintId)
  }

  allConstraints(): IterableIterator<ConstraintRecord> {
    return this.constraintRecords.values()
  }

  constraintsFor(entityId: EntityId): ConstraintRecord[] {
    const ids = this.constraintsByEntity.get(entityId)
    if (!ids) return []
    const records: ConstraintRecord[] = []
    for (const id of ids) {
      const rec = this.constraintRecords.get(id)
      if (rec) records.push(rec)
    }
    return records
  }

  // ── Resource respawn ───────────────────────────────────────────────

  /** Refills depleted nodes whose respawn time passed. Returns refilled entities. */
  respawnDueResources(nowMs: number): GameEntity[] {
    const refilled: GameEntity[] = []
    for (const entity of this.entities.ofKind('resource')) {
      const res = entity.resource
      if (!res || res.remaining > 0 || res.depletedUntil === 0) continue
      if (nowMs < res.depletedUntil) continue
      const nodeType = this.content.nodeType(res.nodeTypeId)
      if (!nodeType) continue
      res.remaining = nodeType.amount
      res.depletedUntil = 0
      entity.dirty = true
      refilled.push(entity)
    }
    return refilled
  }

  // ── Physics sync (sleep tracking) ──────────────────────────────────

  syncFromPhysics(events: {
    onSettle?: (e: GameEntity) => void
    onWake?: (e: GameEntity) => void
  }): { awake: number; settledCount: number } {
    let awake = 0
    for (const entity of this.entities.ofKind('prop')) {
      if (entity.prop?.motion !== 'dynamic') continue
      const bodyId = this.bodyByEntity.get(entity.id)
      if (bodyId === undefined) continue
      const wasSettled = this.settled.has(entity.id)
      const nowSettled = this.physics.isSettled(bodyId)
      if (!nowSettled) {
        awake++
        this.physics.getTransform(bodyId, entity.transform.pos, entity.transform.rot)
        this.spatial.move(entity.id, entity.transform.pos.x, entity.transform.pos.z)
        entity.dirty = true
        if (wasSettled) {
          this.settled.delete(entity.id)
          events.onWake?.(entity)
        }
      } else if (!wasSettled) {
        this.physics.getTransform(bodyId, entity.transform.pos, entity.transform.rot)
        entity.dirty = true
        this.settled.add(entity.id)
        events.onSettle?.(entity)
      }
    }
    return { awake, settledCount: this.settled.size }
  }

  isSettledEntity(id: EntityId): boolean {
    return this.settled.has(id)
  }

  // ── Persistence mapping ────────────────────────────────────────────

  seedOrRestore(store: PersistenceStore): void {
    const world = this.content.world
    const seeded = store.meta.get('world_seeded') === 'yes'
    const worldChanged = store.meta.get('world_id') !== world.id

    if (!seeded) {
      this.seedProps(store)
      this.seedResources(store)
      store.meta.set('world_seeded', 'yes')
      store.meta.set('world_id', world.id)
      this.flushDirty(store)
      this.log.info('world seeded', { world: world.id, entities: this.entities.size })
      return
    }

    const rows = store.worldEntities.loadAll()
    let restored = 0
    for (const row of rows) {
      if (row.kind === 'resource' && worldChanged) continue // re-seeded below
      if (this.restoreEntity(row)) restored++
    }

    // Constraints restore after entities; dangling/invalid records are
    // pruned (an unknown type from a future build, or a despawned prop).
    const constraintRows = store.constraints.loadAll()
    const pruned: string[] = []
    for (const row of constraintRows) {
      const a = this.entities.get(row.entityA as EntityId)
      const b = this.entities.get(row.entityB as EntityId)
      const type = parseConstraintType(row.type)
      const params = (row.params ?? {}) as ConstraintParams
      if (
        a?.prop &&
        b?.prop &&
        type &&
        validateConstraintParams(type, params).ok &&
        this.addConstraintRecord(a, b, type, params, row.id)
      ) {
        this.constraintsDirty.delete(row.id) // just loaded, not dirty
      } else {
        pruned.push(row.id)
      }
    }
    if (pruned.length > 0) store.constraints.deleteMany(pruned)

    if (worldChanged) {
      // The map definition changed: resource layout follows the new world,
      // player constructions persist, players go back to spawn.
      store.worldEntities.deleteByKind('resource')
      this.seedResources(store)
      store.players.resetAllPositions(worldSpawn(world).pos, worldSpawn(world).yaw)
      store.meta.set('world_id', world.id)
      this.flushDirty(store)
      this.log.info('world definition changed — resources re-seeded, players respawned', {
        world: world.id,
      })
    }
    this.log.info('world restored', {
      entities: restored,
      constraints: this.constraintRecords.size,
      prunedConstraints: pruned.length,
    })
  }

  private seedProps(_store: PersistenceStore): void {
    const world = this.content.world
    for (const prop of [...world.initialProps, ...(getMapOverride()?.props ?? [])]) {
      this.spawnProp({
        defId: prop.item,
        pos: vec3(
          prop.pos[0],
          prop.pos[1] + terrainHeight(this.content.world, prop.pos[0], prop.pos[2]),
          prop.pos[2],
        ),
        rot: qfromYaw(quat(), prop.yaw ?? 0),
        // Fixtures (shops) are part of the town; everything else tumbles in.
        motion: this.content.item(prop.item)?.shop ? 'static' : 'dynamic',
      })
    }
  }

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
  reconcileMapNodes(): void {
    const world = this.content.world
    const plan = planMapProvenance(
      getMapOverride()?.nodes ?? [],
      [...this.entities.ofKind('resource')],
      {
        spec: (n: MapNodeSpawn) => ({ id: n.id, defId: n.node, pos: n.pos }),
        entity: (e) => ({
          mapSourceId: e.mapSourceId,
          defId: e.resource?.nodeTypeId ?? '',
          x: e.transform.pos.x,
          z: e.transform.pos.z,
        }),
      },
    )

    for (const entity of plan.despawn) this.despawn(entity.id)
    for (const { entity, spec } of plan.move) {
      // Moving the seed moves the entity and KEEPS what has been mined out of
      // it — an admin nudging a rock does not restock it.
      this.placeAt(entity, spec.pos)
    }
    for (const node of plan.spawn) {
      const nodeType = this.content.nodeTypeOrThrow(node.node)
      const y = node.pos[1] + terrainHeight(world, node.pos[0], node.pos[2])
      const entity = this.spawnResource({
        nodeTypeId: node.node,
        pos: vec3(node.pos[0], y, node.pos[2]),
        remaining: nodeType.amount,
      })
      entity.mapSourceId = node.id
      entity.dirty = true
      this.log.info('map node spawned', { node: node.node, source: node.id })
    }
  }

  /** Reposition an authored entity onto the terrain, body and all. */
  private placeAt(entity: GameEntity, pos: readonly [number, number, number]): void {
    const y = pos[1] + terrainHeight(this.content.world, pos[0], pos[2])
    entity.transform.pos = vec3(pos[0], y, pos[2])
    this.spatial.move(entity.id, entity.transform.pos.x, entity.transform.pos.z)
    entity.dirty = true
    const body = this.bodyOf(entity.id)
    if (body !== undefined) this.physics.setTransform(body, entity.transform.pos)
  }

  /**
   * Apply the map's authored zones. Idempotent by construction: the map layer
   * is REPLACED, never appended, so saving the same map twice cannot stack
   * duplicate rule volumes the way merging into `content.world.zones` would.
   * The base content zones are untouched, so a map can add a restriction but
   * never lift one the world def declared.
   */
  reconcileMapZones(): void {
    this.zones.setMapZones(getMapOverride()?.zones ?? [])
  }

  /**
   * Live map save: map-authored props, by identity.
   *
   * The old rule was "a prop of this item within two metres", so a player's
   * crate dropped beside an authored one suppressed the authored one — and a
   * player's constructions could be mistaken for map seeds. Props with no
   * provenance are never touched here.
   */
  reconcileMapProps(): void {
    const plan = planMapProvenance(
      getMapOverride()?.props ?? [],
      [...this.entities.ofKind('prop')],
      {
        spec: (p: MapPropSpawn) => ({ id: p.id, defId: p.item, pos: p.pos }),
        entity: (e) => ({
          mapSourceId: e.mapSourceId,
          defId: e.prop?.defId ?? '',
          x: e.transform.pos.x,
          z: e.transform.pos.z,
        }),
      },
    )

    for (const entity of plan.despawn) this.despawn(entity.id)
    for (const { entity, spec } of plan.move) this.placeAt(entity, spec.pos)

    for (const prop of plan.spawn) {
      const sourceId = prop.id
      const entity = this.spawnProp({
        defId: prop.item,
        pos: vec3(
          prop.pos[0],
          prop.pos[1] + terrainHeight(this.content.world, prop.pos[0], prop.pos[2]),
          prop.pos[2],
        ),
        rot: qfromYaw(quat(), prop.yaw ?? 0),
        motion: this.content.item(prop.item)?.shop ? 'static' : 'dynamic',
      })
      entity.mapSourceId = sourceId
      entity.dirty = true
      this.log.info('map prop spawned', { item: prop.item, source: sourceId })
    }
  }

  private seedResources(_store: PersistenceStore): void {
    const world = this.content.world
    // World-def nodes have no map provenance; map nodes carry theirs, so a
    // later save can find exactly the entity it authored.
    for (const node of world.resourceNodes) {
      const nodeType = this.content.nodeTypeOrThrow(node.node)
      this.spawnResource({
        nodeTypeId: node.node,
        // Nodes sit ON the terrain, wherever it rolls.
        pos: vec3(
          node.pos[0],
          node.pos[1] + terrainHeight(world, node.pos[0], node.pos[2]),
          node.pos[2],
        ),
        remaining: nodeType.amount,
      })
    }
    for (const node of getMapOverride()?.nodes ?? []) {
      const nodeType = this.content.nodeTypeOrThrow(node.node)
      const entity = this.spawnResource({
        nodeTypeId: node.node,
        pos: vec3(
          node.pos[0],
          node.pos[1] + terrainHeight(world, node.pos[0], node.pos[2]),
          node.pos[2],
        ),
        remaining: nodeType.amount,
      })
      entity.mapSourceId = node.id
    }
  }

  private restoreEntity(row: WorldEntityDto): boolean {
    const pos = vec3(row.pos[0], row.pos[1], row.pos[2])
    const rot = quat(row.rot[0], row.rot[1], row.rot[2], row.rot[3])
    if (row.kind === 'prop') {
      // worldRepOf provides a fallback shape for every known item.
      if (!this.content.item(row.defId)) {
        this.deletedIds.add(row.id as EntityId)
        return false
      }
      const entity = this.spawnProp({
        defId: row.defId,
        pos,
        rot,
        motion: row.motion,
        id: row.id as EntityId,
        lootCount: Number(row.state?.lootCount ?? 1),
        ...(row.ownerId ? { owner: row.ownerId as PlayerId } : {}),
      })
      // Provenance survives the restart, so the first save after one does
      // not treat every authored seed as missing and duplicate the lot.
      const source = readProvenance(row.state)
      if (source !== undefined) entity.mapSourceId = source
      if (entity.prop && typeof row.state?.doorOpen === 'boolean') {
        entity.prop.doorOpen = row.state.doorOpen
      }
      if (entity.prop && typeof row.state?.health === 'number') {
        entity.prop.health = row.state.health
      }
      if (entity.prop && row.state?.plant && typeof row.state.plant === 'object') {
        const raw = row.state.plant as Record<string, unknown>
        if (typeof raw.crop === 'string' && typeof raw.progress === 'number') {
          entity.prop.plant = {
            crop: raw.crop,
            progress: raw.progress,
            water: typeof raw.water === 'number' ? raw.water : 1,
            boost: typeof raw.boost === 'number' ? raw.boost : 1,
            updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
          }
          if (!this.content.crop(entity.prop.plant.crop)) delete entity.prop.plant
        } else {
          // Pre-Stage-4 shape ({seedId, plantedAt}): migrate via the seed
          // item's crop reference; unknown seeds clear the bed.
          const migrated = migrateLegacyPlant(
            raw as { seedId?: string; plantedAt?: number },
            (seedId) => this.content.item(seedId)?.seed?.crop,
            Date.now(),
          )
          if (migrated && this.content.crop(migrated.crop)) entity.prop.plant = migrated
        }
      }
      if (entity.prop && row.state?.machine && typeof row.state.machine === 'object') {
        const rawMachine = row.state.machine as { job?: { recipe?: string; doneAt?: number } }
        if (
          rawMachine.job &&
          typeof rawMachine.job.recipe === 'string' &&
          typeof rawMachine.job.doneAt === 'number'
        ) {
          entity.prop.machine = {
            job: { recipe: rawMachine.job.recipe, doneAt: rawMachine.job.doneAt },
          }
        } else {
          entity.prop.machine = {}
        }
      }
      if (entity.prop && typeof row.state?.burnUntil === 'number') {
        entity.prop.burnUntil = row.state.burnUntil
      }
      if (entity.prop && typeof row.state?.waterAmount === 'number') {
        entity.prop.waterAmount = row.state.waterAmount
      }
      if (entity.prop?.container && Array.isArray(row.state?.container)) {
        const stored = row.state.container as ({ defId: string; count: number } | null)[]
        for (let i = 0; i < entity.prop.container.length && i < stored.length; i++) {
          entity.prop.container[i] = stored[i] ?? null
        }
      }
      entity.dirty = false
      return true
    }
    if (row.kind === 'resource') {
      if (!this.content.nodeType(row.defId)) {
        this.deletedIds.add(row.id as EntityId)
        return false
      }
      const entity = this.spawnResource({
        nodeTypeId: row.defId,
        pos,
        remaining: Number(row.state?.remaining ?? 0),
        depletedUntil: Number(row.state?.depletedUntil ?? 0),
        id: row.id as EntityId,
      })
      // Provenance survives the restart, or the first save after one would
      // treat every authored seed as missing and duplicate the lot.
      const source = readProvenance(row.state)
      if (source !== undefined) entity.mapSourceId = source
      entity.dirty = false
      return true
    }
    return false
  }

  flushDirty(store: PersistenceStore): number {
    const dirty: WorldEntityDto[] = []
    const now = Date.now()
    for (const entity of this.entities.all()) {
      // Players persist via their repository; NPCs via the NpcManager
      // (their abstract state, never the materialized entity).
      if (!entity.dirty || !entity.persistent) continue
      if (entity.kind === 'player' || entity.kind === 'npc') continue
      dirty.push(entityToDto(entity, now))
      entity.dirty = false
    }
    if (dirty.length > 0) store.worldEntities.upsertMany(dirty)
    if (this.deletedIds.size > 0) {
      store.worldEntities.deleteMany([...this.deletedIds])
      this.deletedIds.clear()
    }
    if (this.constraintsDirty.size > 0) {
      const dtos: ConstraintDto[] = []
      for (const id of this.constraintsDirty) {
        const rec = this.constraintRecords.get(id)
        if (rec) {
          dtos.push({
            id: rec.id,
            type: rec.type,
            entityA: rec.a,
            entityB: rec.b,
            params: rec.params as Record<string, unknown>,
            updatedAt: now,
          })
        }
      }
      store.constraints.upsertMany(dtos)
      this.constraintsDirty.clear()
    }
    if (this.constraintsDeleted.size > 0) {
      store.constraints.deleteMany([...this.constraintsDeleted])
      this.constraintsDeleted.clear()
    }
    return dirty.length
  }
}

function entityToDto(entity: GameEntity, now: number): WorldEntityDto {
  const { pos, rot } = entity.transform
  return {
    id: entity.id,
    kind: entity.kind === 'resource' ? 'resource' : 'prop',
    defId: entity.prop?.defId ?? entity.resource?.nodeTypeId ?? 'unknown',
    ownerId: entity.owner ?? null,
    pos: [pos.x, pos.y, pos.z],
    rot: [rot.x, rot.y, rot.z, rot.w],
    motion: entity.prop?.motion ?? 'static',
    state: entity.resource
      ? {
          remaining: entity.resource.remaining,
          depletedUntil: entity.resource.depletedUntil,
          // Provenance survives a restart, or the first save after one would
          // treat every authored seed as missing and duplicate the lot.
          ...provenanceState(entity.mapSourceId),
        }
      : entity.prop
        ? {
            lootCount: entity.prop.lootCount,
            ...provenanceState(entity.mapSourceId),
            ...(entity.prop.container ? { container: entity.prop.container } : {}),
            ...(entity.prop.doorOpen !== undefined ? { doorOpen: entity.prop.doorOpen } : {}),
            ...(entity.prop.plant ? { plant: entity.prop.plant } : {}),
            ...(entity.prop.health !== undefined ? { health: entity.prop.health } : {}),
            ...(entity.prop.machine ? { machine: entity.prop.machine } : {}),
            ...(entity.prop.burnUntil !== undefined ? { burnUntil: entity.prop.burnUntil } : {}),
            ...(entity.prop.waterAmount !== undefined
              ? { waterAmount: entity.prop.waterAmount }
              : {}),
          }
        : null,
    updatedAt: now,
  }
}

const KNOWN_CONSTRAINT_TYPES = new Set([
  'weld',
  'rope',
  'hinge',
  'axis',
  'slider',
  'spring',
  'motor',
])

function parseConstraintType(raw: string): ConstraintType | null {
  return KNOWN_CONSTRAINT_TYPES.has(raw) ? (raw as ConstraintType) : null
}

const asVec = (v: [number, number, number] | undefined): Vec3 =>
  v ? vec3(v[0], v[1], v[2]) : vec3()

/**
 * Maps a gameplay constraint (type + validated params) onto a physics
 * ConstraintDesc. 'axis' is a free hinge; 'motor' is a driven hinge.
 */
function toPhysicsConstraint(
  type: ConstraintType,
  params: ConstraintParams,
  bodyA: BodyId,
  bodyB: BodyId,
): ConstraintDesc | null {
  const anchorA = asVec(params.anchorA)
  const anchorB = asVec(params.anchorB)
  switch (type) {
    case 'weld':
      return { type: 'weld', bodyA, bodyB }
    case 'rope':
      if (params.length === undefined) return null
      return { type: 'rope', bodyA, bodyB, anchorA, anchorB, length: params.length }
    case 'spring':
      if (params.length === undefined) return null
      return {
        type: 'spring',
        bodyA,
        bodyB,
        anchorA,
        anchorB,
        restLength: params.length,
        stiffness: params.stiffness ?? 400,
        damping: params.damping ?? 15,
      }
    case 'hinge':
    case 'axis':
    case 'motor': {
      if (!params.axisA || !params.axisB) return null
      return {
        type: 'hinge',
        bodyA,
        bodyB,
        anchorA,
        anchorB,
        axisA: asVec(params.axisA),
        axisB: asVec(params.axisB),
        ...(type === 'hinge' && params.limits ? { limits: params.limits } : {}),
        ...(type === 'motor' && params.motor ? { motor: params.motor } : {}),
      }
    }
    case 'slider': {
      if (!params.axisA || !params.axisB) return null
      return {
        type: 'slider',
        bodyA,
        bodyB,
        anchorA,
        anchorB,
        axisA: asVec(params.axisA),
        axisB: asVec(params.axisB),
        ...(params.limits ? { limits: params.limits } : {}),
      }
    }
  }
}

export function toShapeDesc(shape: WorldShape): ShapeDesc {
  switch (shape.type) {
    case 'box':
      return { type: 'box', size: shape.size }
    case 'cylinder':
      return { type: 'cylinder', radius: shape.radius, height: shape.height }
    case 'sphere':
      return { type: 'sphere', radius: shape.radius }
  }
}
