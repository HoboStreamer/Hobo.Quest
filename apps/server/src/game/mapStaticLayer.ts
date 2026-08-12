/**
 * The map-authored static collision layer, keyed by stable id.
 *
 * Both sides used to do `content.world.statics.push(...map.statics)` at boot.
 * That merge is permanent: the map layer could never be replaced, so a live
 * save added geometry the physics world never saw, moving a static changed
 * nothing until restart, and re-applying a map appended a second copy of
 * everything. The editor's Save button said "live" while most of the map
 * was not.
 *
 * Held separately and reconciled by id, statics appear, move and vanish on
 * save — and an identical repeated save touches no body at all, which matters
 * because the editor saves often and a heightfield rebuild is not free.
 */
import type { StaticBody } from '@hobo/content'
import { effectiveShape } from '@hobo/content'
import { toShapeDesc } from './gameWorld.js'
import { CollisionLayer, type BodyId, type PhysicsWorld } from '@hobo/physics'
import { qfromEuler, qfromYaw, quat, vec3 } from '@hobo/shared'

/** Canonical value of a static, so an unchanged one is left alone. */
export function staticSignature(s: StaticBody): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b))),
  )
}

/** Only add/remove: a static body's transform is not edited in place. */
type BodyPhysics = Pick<PhysicsWorld, 'addBody' | 'removeBody'>

export class MapStaticLayer {
  private readonly bodies = new Map<string, { body: BodyId; signature: string }>()

  /**
   * Cumulative bodies created and destroyed. Exposed so "an identical save
   * causes no churn" is checkable from outside the process rather than
   * inferred from a count that would look the same either way.
   */
  rebuilds = 0

  constructor(private readonly physics: BodyPhysics) {}

  get size(): number {
    return this.bodies.size
  }

  /** The body for a map static, for tests and diagnostics. */
  bodyOf(id: string): BodyId | undefined {
    return this.bodies.get(id)?.body
  }

  /**
   * Make the layer match `statics`. Bodies whose canonical value is unchanged
   * are kept as-is; everything else is replaced or dropped.
   *
   * A static with no id cannot be reconciled — `parseMapFile` guarantees one,
   * so this only bites hand-written override data, and skipping is safer than
   * minting a body nothing can ever remove.
   */
  reconcile(statics: readonly StaticBody[]): void {
    const next = new Map<string, StaticBody>()
    for (const s of statics) if (s.id) next.set(s.id, s)

    for (const [id, entry] of this.bodies) {
      const after = next.get(id)
      if (after && staticSignature(after) === entry.signature) continue
      this.physics.removeBody(entry.body)
      this.rebuilds++
      this.bodies.delete(id)
    }
    for (const [id, s] of next) {
      if (this.bodies.has(id)) continue
      this.bodies.set(id, { body: this.addBody(s), signature: staticSignature(s) })
    }
  }

  /** Drop every body (world teardown). */
  clear(): void {
    for (const { body } of this.bodies.values()) this.physics.removeBody(body)
    this.bodies.clear()
  }

  private addBody(s: StaticBody): BodyId {
    return this.physics.addBody({
      // Scaled render and scaled collision or neither, never one without the
      // other — the same helper the client and renderer go through.
      shape: toShapeDesc(effectiveShape(s)),
      motion: 'static',
      pos: vec3(s.pos[0], s.pos[1], s.pos[2]),
      rot: s.rot ? qfromEuler(quat(), s.rot[0], s.rot[1], s.rot[2]) : qfromYaw(quat(), s.yaw),
      layer: CollisionLayer.Static,
      collidesWith: CollisionLayer.Prop | CollisionLayer.Player,
    })
  }
}
