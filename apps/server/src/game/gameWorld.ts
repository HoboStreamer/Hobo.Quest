import type { ContentRegistry, WorldShape } from '@hobo/content'
import { EntityStore, ZoneIndex, type GameEntity, type MotionState } from '@hobo/gameplay'
import type { PersistenceStore, WorldEntityDto } from '@hobo/persistence'
import { CollisionLayer, type BodyId, type PhysicsWorld, type ShapeDesc } from '@hobo/physics'
import {
  asItemDefId,
  newEntityId,
  qfromYaw,
  quat,
  vec3,
  type EntityId,
  type Logger,
  type PlayerId,
  type Quat,
  type Vec3,
} from '@hobo/shared'

/**
 * Authoritative world state: the entity store, its physical counterparts,
 * and the mapping between them. Persistence works exclusively through DTOs
 * built here — physics bodies and entity records are runtime-only.
 */

const PROP_COLLIDES = CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player

export class GameWorld {
  readonly entities = new EntityStore()
  readonly zones: ZoneIndex
  private readonly bodyByEntity = new Map<EntityId, BodyId>()
  private readonly entityByBody = new Map<BodyId, EntityId>()
  /** Entities whose props were settled last time we checked (sleep tracking). */
  private readonly settled = new Set<EntityId>()
  /** Ids deleted since the last persistence flush. */
  private readonly deletedIds = new Set<EntityId>()

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
    this.physics.addBody({
      shape: { type: 'box', size: [world.groundHalfExtent * 2, 1, world.groundHalfExtent * 2] },
      motion: 'static',
      pos: vec3(0, -0.5, 0),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
    for (const s of world.statics) {
      this.physics.addBody({
        shape: toShapeDesc(s.shape),
        motion: 'static',
        pos: vec3(s.pos[0], s.pos[1], s.pos[2]),
        rot: qfromYaw(quat(), s.yaw),
        layer: CollisionLayer.Static,
        collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
      })
    }
  }

  bodyOf(id: EntityId): BodyId | undefined {
    return this.bodyByEntity.get(id)
  }

  entityOfBody(body: BodyId): GameEntity | undefined {
    const id = this.entityByBody.get(body)
    return id ? this.entities.get(id) : undefined
  }

  /** Spawns a physical prop entity (from placement, world seeding, or restore). */
  spawnProp(opts: {
    defId: string
    pos: Vec3
    rot: Quat
    motion: MotionState
    owner?: PlayerId
    id?: EntityId
  }): GameEntity {
    const def = this.content.itemOrThrow(opts.defId)
    if (!def.world) throw new Error(`item '${opts.defId}' has no world capability`)
    const entity: GameEntity = {
      id: opts.id ?? newEntityId(),
      kind: 'prop',
      transform: { pos: { ...opts.pos }, rot: { ...opts.rot } },
      prop: { defId: opts.defId, motion: opts.motion },
      ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
      persistent: true,
      dirty: true,
    }
    this.entities.add(entity)
    const bodyId = this.physics.addBody({
      shape: toShapeDesc(def.world.shape),
      motion: opts.motion === 'dynamic' ? 'dynamic' : 'static',
      pos: opts.pos,
      rot: opts.rot,
      massKg: def.world.massKg,
      layer: CollisionLayer.Prop,
      collidesWith: PROP_COLLIDES,
    })
    this.bodyByEntity.set(entity.id, bodyId)
    this.entityByBody.set(bodyId, entity.id)
    return entity
  }

  /** Spawns a gatherable resource node (static, no physics interaction needed beyond blocking). */
  spawnResource(opts: {
    itemId: string
    pos: Vec3
    remaining: number
    perUse: number
    id?: EntityId
  }): GameEntity {
    const entity: GameEntity = {
      id: opts.id ?? newEntityId(),
      kind: 'resource',
      transform: { pos: { ...opts.pos }, rot: quat() },
      resource: { itemId: opts.itemId, remaining: opts.remaining, perUse: opts.perUse },
      persistent: true,
      dirty: true,
    }
    this.entities.add(entity)
    const bodyId = this.physics.addBody({
      shape: { type: 'box', size: [0.8, 0.8, 0.8] },
      motion: 'static',
      pos: opts.pos,
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
    const bodyId = this.bodyByEntity.get(id)
    if (bodyId !== undefined) {
      this.physics.removeBody(bodyId)
      this.bodyByEntity.delete(id)
      this.entityByBody.delete(bodyId)
    }
    this.settled.delete(id)
    if (entity.persistent) this.deletedIds.add(id)
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

  /**
   * Post-physics sync: copy transforms of awake dynamic props back into
   * entity records, mark persistence-dirty, and detect settle transitions.
   * Settled props cost nothing here — the sleep system in action.
   */
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

  /** First boot: seed initial world content. Afterwards the DB is authoritative. */
  seedOrRestore(store: PersistenceStore): void {
    if (store.meta.get('world_seeded') === 'yes') {
      const rows = store.worldEntities.loadAll()
      for (const row of rows) this.restoreEntity(row)
      this.log.info('world restored', { entities: rows.length })
      return
    }
    const world = this.content.world
    for (const prop of world.initialProps) {
      this.spawnProp({
        defId: prop.item,
        pos: vec3(prop.pos[0], prop.pos[1], prop.pos[2]),
        rot: qfromYaw(quat(), prop.yaw),
        motion: 'dynamic',
      })
    }
    for (const node of world.resourceNodes) {
      this.spawnResource({
        itemId: node.item,
        pos: vec3(node.pos[0], node.pos[1], node.pos[2]),
        remaining: node.amount,
        perUse: node.perUse,
      })
    }
    store.meta.set('world_seeded', 'yes')
    this.flushDirty(store)
    this.log.info('world seeded', { entities: this.entities.size })
  }

  private restoreEntity(row: WorldEntityDto): void {
    const pos = vec3(row.pos[0], row.pos[1], row.pos[2])
    const rot = quat(row.rot[0], row.rot[1], row.rot[2], row.rot[3])
    if (row.kind === 'prop') {
      const entity = this.spawnProp({
        defId: row.defId,
        pos,
        rot,
        motion: row.motion,
        id: row.id as EntityId,
        ...(row.ownerId ? { owner: row.ownerId as PlayerId } : {}),
      })
      entity.dirty = false
    } else if (row.kind === 'resource') {
      const remaining = Number(row.state?.remaining ?? 0)
      if (remaining <= 0) return
      const entity = this.spawnResource({
        itemId: asItemDefId(row.defId),
        pos,
        remaining,
        perUse: Number(row.state?.perUse ?? 1),
        id: row.id as EntityId,
      })
      entity.dirty = false
    }
  }

  /** Batched dirty write-out. Returns number of rows written. */
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
    return dirty.length
  }
}

function entityToDto(entity: GameEntity, now: number): WorldEntityDto {
  const { pos, rot } = entity.transform
  return {
    id: entity.id,
    kind: entity.kind === 'resource' ? 'resource' : 'prop',
    defId: entity.prop?.defId ?? entity.resource?.itemId ?? 'unknown',
    ownerId: entity.owner ?? null,
    pos: [pos.x, pos.y, pos.z],
    rot: [rot.x, rot.y, rot.z, rot.w],
    motion: entity.prop?.motion ?? 'static',
    state: entity.resource
      ? { remaining: entity.resource.remaining, perUse: entity.resource.perUse }
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
