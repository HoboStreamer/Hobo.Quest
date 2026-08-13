import {
  StraightLineNavigation,
  perceive,
  stepBehavior,
  type GameEntity,
  type NavigationService,
  type NpcState,
  type PerceptionCandidate,
} from '@hobo/gameplay'
import { NPC_SPAWNS, terrainHeight } from '@hobo/content'
import { CollisionLayer, type BodyId } from '@hobo/physics'
import type { PersistenceStore, WorldEntityDto } from '@hobo/persistence'
import {
  asEntityId,
  newEntityId,
  qfromYaw,
  quat,
  vec3,
  type EntityId,
  type Logger,
} from '@hobo/shared'
import type { GameWorld } from './gameWorld.js'
import type { RegionTracker } from '@hobo/gameplay'

/**
 * Server-authoritative NPC simulation with explicit LOD:
 *
 *  - FULL (active region): perception, behavior, kinematic movement on the
 *    terrain, a physics capsule so bullets/props/players collide, entity
 *    replication through the normal interest pipeline.
 *  - ABSTRACT (inactive region): a record — position, health, respawn
 *    timer. No entity, no body, no perception, no per-tick anything.
 *
 * Materialization follows region activation; collapsing back is safe
 * because the abstract record IS the persistent state.
 */

const FULL_SIM_HZ = 5 // behavior/perception cadence (movement runs at tick rate)

export interface NpcHooks {
  /** NPC melee lands on a player (id = player ENTITY id). */
  onAttackPlayer(npcEntityId: EntityId, playerEntityId: string, damage: number): void
  /** Sound events this second (gunshots, fights) for hearing. */
  soundsThisTick(): readonly { x: number; z: number }[]
  /** Candidate actors near a point (players + hostile NPC logic later). */
  hostilesNear(x: number, z: number, radius: number, faction: string): PerceptionCandidate[]
}

export class NpcManager {
  /** ALL NPC instances, materialized or not, by instance id. */
  private readonly states = new Map<string, NpcState>()
  /** Materialized subset: instance id -> physics body. */
  private readonly bodies = new Map<string, BodyId>()
  private readonly navigation: NavigationService = new StraightLineNavigation()
  private behaviorPhase = 0

  constructor(
    private readonly world: GameWorld,
    private readonly regions: RegionTracker,
    private readonly hooks: NpcHooks,
    private readonly log: Logger,
  ) {}

  /** Boot: restore persisted NPCs, then seed content spawns not yet known. */
  seedOrRestore(store: PersistenceStore): void {
    const rows = store.worldEntities.loadAll().filter((r) => r.kind === 'npc')
    for (const row of rows) {
      const arch = this.world.content.npc(row.defId)
      if (!arch) continue
      const s = row.state ?? {}
      this.states.set(row.id, {
        id: row.id,
        archetype: row.defId,
        x: row.pos[0],
        z: row.pos[2],
        yaw: 0,
        health: typeof s.health === 'number' ? s.health : arch.health,
        homeX: typeof s.homeX === 'number' ? s.homeX : row.pos[0],
        homeZ: typeof s.homeZ === 'number' ? s.homeZ : row.pos[2],
        state: 'idle',
        stateUntil: 0,
        lastAttackMs: 0,
        respawnAt: typeof s.respawnAt === 'number' ? s.respawnAt : 0,
      })
    }
    // Content spawns missing from the save (fresh world or new content).
    for (const [index, spawn] of NPC_SPAWNS.entries()) {
      const arch = this.world.content.npc(spawn.archetype)
      if (!arch) continue
      const known = [...this.states.values()].some(
        (s) =>
          s.archetype === spawn.archetype &&
          Math.hypot(s.homeX - spawn.pos[0], s.homeZ - spawn.pos[2]) < 2,
      )
      if (known) continue
      const id = newEntityId()
      this.states.set(id, {
        id,
        archetype: spawn.archetype,
        x: spawn.pos[0],
        z: spawn.pos[2],
        yaw: (index * 1.7) % (Math.PI * 2),
        health: arch.health,
        homeX: spawn.pos[0],
        homeZ: spawn.pos[2],
        state: 'idle',
        stateUntil: 0,
        lastAttackMs: 0,
        respawnAt: 0,
      })
    }
    this.log.info('npcs ready', { count: this.states.size })
  }

  /** Counts for metrics: [full-sim, abstract]. */
  counts(): [number, number] {
    return [this.bodies.size, this.states.size - this.bodies.size]
  }

  npcStateOf(entityId: EntityId): NpcState | undefined {
    return this.states.get(entityId as string)
  }

  /**
   * Damage an NPC (melee/ranged already mitigated upstream). Returns the
   * loot scattered on death, or null while it survives.
   */
  damage(entityId: EntityId, amount: number, nowMs: number): 'dead' | 'hurt' | null {
    const npc = this.states.get(entityId as string)
    const arch = npc ? this.world.content.npc(npc.archetype) : undefined
    if (!npc || !arch || npc.respawnAt > 0) return null
    npc.health -= amount
    if (npc.health > 0) return 'hurt'
    npc.respawnAt = nowMs + arch.respawnSeconds * 1000
    npc.health = 0
    this.dematerialize(npc)
    return 'dead'
  }

  /** One simulation step; call every server tick. */
  step(nowMs: number, tick: number, tickRate: number): void {
    // Materialization sweep at 1 Hz: bodies follow region activation.
    if (tick % tickRate === 0) {
      for (const npc of this.states.values()) {
        const materialized = this.bodies.has(npc.id)
        // Respawn: timer elapsed → back to life at home.
        if (npc.respawnAt > 0 && nowMs >= npc.respawnAt) {
          const arch = this.world.content.npc(npc.archetype)
          npc.respawnAt = 0
          npc.health = arch?.health ?? 1
          npc.x = npc.homeX
          npc.z = npc.homeZ
          npc.state = 'idle'
        }
        const wantFull = npc.respawnAt === 0 && this.regions.isActive(npc.x, npc.z)
        if (wantFull && !materialized) this.materialize(npc)
        else if (!wantFull && materialized) this.dematerialize(npc)
      }
    }

    // Full-sim NPCs: staggered behavior (FULL_SIM_HZ), movement every tick.
    const behaviorInterval = Math.max(1, Math.floor(tickRate / FULL_SIM_HZ))
    this.behaviorPhase = (this.behaviorPhase + 1) % behaviorInterval
    let index = 0
    for (const [id, bodyId] of this.bodies) {
      const npc = this.states.get(id)
      const arch = npc ? this.world.content.npc(npc.archetype) : undefined
      if (!npc || !arch) continue
      index++
      // Behavior/perception on a stagger so 100 NPCs don't all think at once.
      if (index % behaviorInterval === this.behaviorPhase) {
        const candidates = this.hooks.hostilesNear(
          npc.x,
          npc.z,
          arch.perception.viewDistance,
          arch.faction,
        )
        const perception = perceive(
          npc,
          arch,
          candidates,
          this.hooks.soundsThisTick(),
          (fx, fz, tx, tz) => this.lineOfSight(fx, fz, tx, tz),
        )
        const decision = stepBehavior(npc, arch, perception, nowMs, Math.random)
        if (decision.state !== npc.state) {
          this.log.debug('npc state', {
            archetype: npc.archetype,
            from: npc.state,
            to: decision.state,
            threat: perception.threat?.id ?? 'none',
            threatDist: perception.threat ? Math.round(perception.threat.dist * 10) / 10 : -1,
          })
        }
        npc.state = decision.state
        if (perception.threat) npc.threatId = perception.threat.id
        else delete npc.threatId
        if (decision.moveX !== undefined && decision.moveZ !== undefined) {
          const path = this.navigation.requestPath(npc.x, npc.z, decision.moveX, decision.moveZ)
          const waypoint = path?.[0]
          if (waypoint) {
            npc.targetX = waypoint.x
            npc.targetZ = waypoint.z
          }
        } else if (decision.state === 'idle' || decision.state === 'attack') {
          delete npc.targetX
          delete npc.targetZ
        }
        if (decision.attackId) {
          npc.lastAttackMs = nowMs
          this.hooks.onAttackPlayer(
            asEntityId(npc.id),
            decision.attackId,
            arch.behavior.attackDamage,
          )
        }
      }
      // Movement toward the current waypoint (kinematic, terrain-following).
      if (npc.targetX !== undefined && npc.targetZ !== undefined) {
        const dx = npc.targetX - npc.x
        const dz = npc.targetZ - npc.z
        const dist = Math.hypot(dx, dz)
        if (dist < 0.3) {
          delete npc.targetX
          delete npc.targetZ
        } else {
          const speed =
            npc.state === 'chase' || npc.state === 'flee' ? arch.moveSpeed : arch.moveSpeed * 0.55
          const step = Math.min(dist, speed / tickRate)
          npc.x += (dx / dist) * step
          npc.z += (dz / dist) * step
          npc.yaw = Math.atan2(dx, dz)
        }
      }
      // Sync entity + body + spatial from the authoritative state.
      const entity = this.world.entities.get(asEntityId(npc.id))
      if (entity) {
        const y = terrainHeight(this.world.content.world, npc.x, npc.z) + arch.heightM / 2
        entity.transform.pos.x = npc.x
        entity.transform.pos.y = y
        entity.transform.pos.z = npc.z
        qfromYaw(entity.transform.rot, npc.yaw)
        this.world.spatial.move(entity.id, npc.x, npc.z)
        this.world.physics.setTransform(bodyId, entity.transform.pos)
      }
    }
  }

  /** Entity ids of materialized NPCs whose pose changed (for snapshots). */
  *materializedIds(): IterableIterator<EntityId> {
    for (const id of this.bodies.keys()) yield asEntityId(id)
  }

  private materialize(npc: NpcState): void {
    const arch = this.world.content.npc(npc.archetype)
    if (!arch) return
    const y = terrainHeight(this.world.content.world, npc.x, npc.z) + arch.heightM / 2
    const entity: GameEntity = {
      id: asEntityId(npc.id),
      kind: 'npc',
      transform: { pos: vec3(npc.x, y, npc.z), rot: qfromYaw(quat(), npc.yaw) },
      npc,
      persistent: true,
      dirty: true,
    }
    this.world.entities.add(entity)
    this.world.spatial.insert(entity.id, npc.x, npc.z)
    const bodyId = this.world.physics.addBody({
      shape: { type: 'capsule', radius: arch.radius, height: arch.heightM },
      motion: 'kinematic',
      pos: entity.transform.pos,
      layer: CollisionLayer.Player,
      collidesWith: CollisionLayer.Static | CollisionLayer.Prop | CollisionLayer.Player,
    })
    this.bodies.set(npc.id, bodyId)
    this.world.registerNpcBody(bodyId, asEntityId(npc.id))
  }

  private dematerialize(npc: NpcState): void {
    const bodyId = this.bodies.get(npc.id)
    if (bodyId !== undefined) {
      this.world.physics.removeBody(bodyId)
      this.world.unregisterNpcBody(bodyId)
      this.bodies.delete(npc.id)
    }
    this.world.entities.remove(asEntityId(npc.id))
    this.world.spatial.remove(asEntityId(npc.id))
  }

  private lineOfSight(fx: number, fz: number, tx: number, tz: number): boolean {
    const world = this.world.content.world
    const fromY = terrainHeight(world, fx, fz) + 1.4
    const toY = terrainHeight(world, tx, tz) + 1.4
    const hit = this.world.physics.raycast(
      vec3(fx, fromY, fz),
      vec3(tx, toY, tz),
      CollisionLayer.Static,
    )
    return hit === null
  }

  /** Persistence: NPCs write their ABSTRACT state (never bodies/entities). */
  flush(store: PersistenceStore, now: number): void {
    const dtos: WorldEntityDto[] = []
    for (const npc of this.states.values()) {
      dtos.push({
        id: npc.id,
        kind: 'npc',
        defId: npc.archetype,
        ownerId: null,
        pos: [npc.x, 0, npc.z],
        rot: [0, 0, 0, 1],
        motion: 'static',
        state: {
          health: npc.health,
          homeX: npc.homeX,
          homeZ: npc.homeZ,
          respawnAt: npc.respawnAt,
        },
        updatedAt: now,
      })
    }
    if (dtos.length > 0) store.worldEntities.upsertMany(dtos)
  }
}
