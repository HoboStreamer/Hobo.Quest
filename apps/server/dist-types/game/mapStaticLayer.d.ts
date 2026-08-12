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
import { type BodyId, type PhysicsWorld } from '@hobo/physics'
/** Canonical value of a static, so an unchanged one is left alone. */
export declare function staticSignature(s: StaticBody): string
/** Only add/remove: a static body's transform is not edited in place. */
type BodyPhysics = Pick<PhysicsWorld, 'addBody' | 'removeBody'>
export declare class MapStaticLayer {
  private readonly physics
  private readonly bodies
  constructor(physics: BodyPhysics)
  get size(): number
  /** The body for a map static, for tests and diagnostics. */
  bodyOf(id: string): BodyId | undefined
  /**
   * Make the layer match `statics`. Bodies whose canonical value is unchanged
   * are kept as-is; everything else is replaced or dropped.
   *
   * A static with no id cannot be reconciled — `parseMapFile` guarantees one,
   * so this only bites hand-written override data, and skipping is safer than
   * minting a body nothing can ever remove.
   */
  reconcile(statics: readonly StaticBody[]): void
  /** Drop every body (world teardown). */
  clear(): void
  private addBody
}
export {}
//# sourceMappingURL=mapStaticLayer.d.ts.map
