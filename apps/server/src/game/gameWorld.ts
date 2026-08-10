import { buildTerrainGrid, terrainHeight } from '@hobo/content'
import type { ContentRegistry, WorldShape } from '@hobo/content'
import { EntityStore, ZoneIndex, type GameEntity, type MotionState } from '@hobo/gameplay'
import type { ConstraintDto, PersistenceStore, WorldEntityDto } from '@hobo/persistence'
import {
  CollisionLayer,
  type BodyId,
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

interface WeldRecord {
  id: string
  a: EntityId
  b: EntityId
  physId: ConstraintId
}

export class GameWorld {
  readonly entities = new EntityStore()
  readonly zones: ZoneIndex
  private readonly bodyByEntity = new Map<EntityId, BodyId>()
  private readonly entityByBody = new Map<BodyId, EntityId>()
  private readonly settled = new Set<EntityId>()
  private readonly deletedIds = new Set<EntityId>()

  private readonly welds = new Map<string, WeldRecord>()
  private readonly weldsByEntity = new Map<EntityId, Set<string>>()
  private readonly weldsDirty = new Set<string>()
  private readonly weldsDeleted = new Set<string>()

  constructor(
    readonly content: ContentRegistry,
    readonly physics: PhysicsWorld,
    private readonly log: Logger,
  ) {
    this.zones = new ZoneIndex(content.world.zones)
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
    for (const s of world.statics) {
      this.physics.addBody({
        shape: toShapeDesc(s.shape),
        motion: 'static',
        pos: vec3(s.pos[0], s.pos[1], s.pos[2]),
        rot: s.rot ? qfromEuler(quat(), s.rot[0], s.rot[1], s.rot[2]) : qfromYaw(quat(), s.yaw),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
      })
    }
  }

  private terrainBody: BodyId | null = null

  private buildTerrainBody(): BodyId {
    const grid = buildTerrainGrid(this.content.world)
    return this.physics.addBody({
      shape: { type: 'trimesh', positions: grid.positions, indices: grid.indices },
      motion: 'static',
      pos: vec3(0, 0, 0),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }

  /** Live map edit: swap the terrain collision for the new heightfield. */
  rebuildTerrain(): void {
    if (this.terrainBody !== null) this.physics.removeBody(this.terrainBody)
    this.terrainBody = this.buildTerrainBody()
  }

  bodyOf(id: EntityId): BodyId | undefined {
    return this.bodyByEntity.get(id)
  }

  entityOfBody(body: BodyId): GameEntity | undefined {
    const id = this.entityByBody.get(body)
    return id ? this.entities.get(id) : undefined
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
    this.removeWeldsFor(id)
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
    this.physics.setMotionType(bodyId, motion === 'dynamic' ? 'dynamic' : 'static')
    if (motion === 'dynamic') this.settled.delete(entity.id)
  }

  // ── Welds ──────────────────────────────────────────────────────────

  hasWeld(a: EntityId, b: EntityId): boolean {
    const set = this.weldsByEntity.get(a)
    if (!set) return false
    for (const id of set) {
      const weld = this.welds.get(id)
      if (weld && (weld.b === b || weld.a === b)) return true
    }
    return false
  }

  weldCountFor(id: EntityId): number {
    return this.weldsByEntity.get(id)?.size ?? 0
  }

  addWeld(a: GameEntity, b: GameEntity, id?: string): WeldRecord | null {
    const bodyA = this.bodyByEntity.get(a.id)
    const bodyB = this.bodyByEntity.get(b.id)
    if (bodyA === undefined || bodyB === undefined) return null
    const physId = this.physics.addConstraint({ type: 'weld', bodyA, bodyB })
    const record: WeldRecord = { id: id ?? newUid(), a: a.id, b: b.id, physId }
    this.welds.set(record.id, record)
    this.indexWeld(record.a, record.id)
    this.indexWeld(record.b, record.id)
    this.weldsDirty.add(record.id)
    this.settled.delete(a.id)
    this.settled.delete(b.id)
    return record
  }

  /** Removes every weld touching the entity; returns the removed records. */
  removeWeldsFor(entityId: EntityId): WeldRecord[] {
    const ids = this.weldsByEntity.get(entityId)
    if (!ids || ids.size === 0) return []
    const removed: WeldRecord[] = []
    for (const id of [...ids]) {
      const weld = this.welds.get(id)
      if (!weld) continue
      this.physics.removeConstraint(weld.physId)
      this.welds.delete(id)
      this.weldsByEntity.get(weld.a)?.delete(id)
      this.weldsByEntity.get(weld.b)?.delete(id)
      this.weldsDirty.delete(id)
      this.weldsDeleted.add(id)
      removed.push(weld)
    }
    return removed
  }

  private indexWeld(entityId: EntityId, weldId: string): void {
    let set = this.weldsByEntity.get(entityId)
    if (!set) {
      set = new Set()
      this.weldsByEntity.set(entityId, set)
    }
    set.add(weldId)
  }

  allWelds(): IterableIterator<WeldRecord> {
    return this.welds.values()
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

    // Constraints restore after entities; dangling records are pruned.
    const constraintRows = store.constraints.loadAll()
    const pruned: string[] = []
    for (const row of constraintRows) {
      const a = this.entities.get(row.entityA as EntityId)
      const b = this.entities.get(row.entityB as EntityId)
      if (a?.prop && b?.prop && this.addWeld(a, b, row.id)) {
        this.weldsDirty.delete(row.id) // just loaded, not dirty
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
      store.players.resetAllPositions(
        [world.spawnPoint[0], world.spawnPoint[1], world.spawnPoint[2]],
        world.spawnYaw,
      )
      store.meta.set('world_id', world.id)
      this.flushDirty(store)
      this.log.info('world definition changed — resources re-seeded, players respawned', {
        world: world.id,
      })
    }
    this.log.info('world restored', {
      entities: restored,
      welds: this.welds.size,
      prunedWelds: pruned.length,
    })
  }

  private seedProps(_store: PersistenceStore): void {
    const world = this.content.world
    for (const prop of world.initialProps) {
      this.spawnProp({
        defId: prop.item,
        pos: vec3(
          prop.pos[0],
          prop.pos[1] + terrainHeight(this.content.world, prop.pos[0], prop.pos[2]),
          prop.pos[2],
        ),
        rot: qfromYaw(quat(), prop.yaw),
        // Fixtures (shops) are part of the town; everything else tumbles in.
        motion: this.content.item(prop.item)?.shop ? 'static' : 'dynamic',
      })
    }
  }

  private seedResources(_store: PersistenceStore): void {
    const world = this.content.world
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
      if (entity.prop && typeof row.state?.doorOpen === 'boolean') {
        entity.prop.doorOpen = row.state.doorOpen
      }
      if (entity.prop && row.state?.plant && typeof row.state.plant === 'object') {
        const plant = row.state.plant as { seedId?: string; plantedAt?: number }
        if (plant.seedId && typeof plant.plantedAt === 'number') {
          entity.prop.plant = { seedId: plant.seedId, plantedAt: plant.plantedAt }
        }
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
      entity.dirty = false
      return true
    }
    return false
  }

  flushDirty(store: PersistenceStore): number {
    const dirty: WorldEntityDto[] = []
    const now = Date.now()
    for (const entity of this.entities.all()) {
      if (!entity.dirty || !entity.persistent || entity.kind === 'player') continue
      dirty.push(entityToDto(entity, now))
      entity.dirty = false
    }
    if (dirty.length > 0) store.worldEntities.upsertMany(dirty)
    if (this.deletedIds.size > 0) {
      store.worldEntities.deleteMany([...this.deletedIds])
      this.deletedIds.clear()
    }
    if (this.weldsDirty.size > 0) {
      const dtos: ConstraintDto[] = []
      for (const id of this.weldsDirty) {
        const weld = this.welds.get(id)
        if (weld) {
          dtos.push({ id: weld.id, type: 'weld', entityA: weld.a, entityB: weld.b, updatedAt: now })
        }
      }
      store.constraints.upsertMany(dtos)
      this.weldsDirty.clear()
    }
    if (this.weldsDeleted.size > 0) {
      store.constraints.deleteMany([...this.weldsDeleted])
      this.weldsDeleted.clear()
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
      ? { remaining: entity.resource.remaining, depletedUntil: entity.resource.depletedUntil }
      : entity.prop
        ? {
            lootCount: entity.prop.lootCount,
            ...(entity.prop.container ? { container: entity.prop.container } : {}),
            ...(entity.prop.doorOpen !== undefined ? { doorOpen: entity.prop.doorOpen } : {}),
            ...(entity.prop.plant ? { plant: entity.prop.plant } : {}),
          }
        : null,
    updatedAt: now,
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
