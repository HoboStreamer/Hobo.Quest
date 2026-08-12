import type { EntityId, PlayerId, Quat, Vec3 } from '@hobo/shared'

/**
 * Domain entity model: composition via optional component fields on a small
 * record — no GameObject hierarchy, no engine types. Runtime physics bodies
 * and render meshes are transient adapters keyed by EntityId; persistence
 * serializes these records (via DTOs), never engine objects.
 *
 * This is intentionally a lightweight component-record design rather than a
 * full archetype ECS; systems iterate the typed indexes below. If profiling
 * ever demands cache-friendly iteration we can migrate storage without
 * changing system code, which only sees query methods.
 */

export interface Transform {
  pos: Vec3
  rot: Quat
}

export type MotionState = 'dynamic' | 'frozen' | 'static'

export type EntityKind = 'player' | 'prop' | 'resource'

export interface PropComponent {
  defId: string
  motion: MotionState
  /** Items recovered by picking this prop up (E). Most props carry their own item. */
  lootCount: number
  /** Stored items for container props (storage boxes). Fixed slot array. */
  container?: ({ defId: string; count: number } | null)[]
  /** Hinged door state (frozen doors toggle with E). */
  doorOpen?: boolean
  /** Growing crop on planter props (timestamp-based; no per-tick sim). */
  plant?: { seedId: string; plantedAt: number }
}

export interface ResourceComponent {
  /** Resource node type id (content-defined behavior: yield, tool, respawn, XP). */
  nodeTypeId: string
  remaining: number
  /** Epoch ms when a depleted node refills; 0 while the node has stock. */
  depletedUntil: number
}

export interface GameEntity {
  readonly id: EntityId
  readonly kind: EntityKind
  transform: Transform
  prop?: PropComponent
  resource?: ResourceComponent
  /** Owning player (spawner) — placement/physgun permission checks use this. */
  owner?: PlayerId
  /**
   * The MAP object that authored this entity, when one did.
   *
   * Map reconciliation used to match by proximity — same type within a metre
   * — which is not identity: two deliberately close authored nodes collapsed
   * into one, a player's crate dropped near an authored one suppressed it,
   * and a moved seed spawned a duplicate rather than moving. Provenance is
   * explicit, so reconciliation can only ever touch what the map owns.
   *
   * Absent means player-created. Those are never removed by a map save.
   */
  mapSourceId?: string
  /** Persisted across restarts (player constructions yes, players no — they persist separately). */
  persistent: boolean
  /** Needs a persistence write. Set by mutators, cleared by the save flush. */
  dirty: boolean
}

export class EntityStore {
  private readonly entities = new Map<EntityId, GameEntity>()
  private readonly byKind = new Map<EntityKind, Set<EntityId>>()

  add(entity: GameEntity): void {
    if (this.entities.has(entity.id)) throw new Error(`duplicate entity id ${entity.id}`)
    this.entities.set(entity.id, entity)
    let set = this.byKind.get(entity.kind)
    if (!set) {
      set = new Set()
      this.byKind.set(entity.kind, set)
    }
    set.add(entity.id)
  }

  remove(id: EntityId): GameEntity | undefined {
    const entity = this.entities.get(id)
    if (!entity) return undefined
    this.entities.delete(id)
    this.byKind.get(entity.kind)?.delete(id)
    return entity
  }

  get(id: EntityId): GameEntity | undefined {
    return this.entities.get(id)
  }

  *ofKind(kind: EntityKind): IterableIterator<GameEntity> {
    const set = this.byKind.get(kind)
    if (!set) return
    for (const id of set) {
      const e = this.entities.get(id)
      if (e) yield e
    }
  }

  all(): IterableIterator<GameEntity> {
    return this.entities.values()
  }

  get size(): number {
    return this.entities.size
  }
}
