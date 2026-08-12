/**
 * The game client's map layers, reconciled by stable id.
 *
 * A `map_reload` used to rebuild every category wholesale: dispose every
 * terrain mesh, every terrain collider, every map static, every map light,
 * and make them all again. Moving one box therefore re-parsed and re-uploaded
 * the geometry of the entire map to the GPU, and rebuilt collision the player
 * was standing on — which is visible as a hitch and, mid-jump, as a fall.
 *
 * The same `diffMapFileV2` the server uses says exactly what changed, and
 * `affectsCollision` says whether a change is appearance-only. Everything
 * here keys on the document's stable ids, so client rendering, client
 * prediction physics and server physics stay in agreement about which object
 * is which.
 */
import type { Scene } from '@babylonjs/core/scene.js'
import { type MapDiff, type MapFileV2 } from '@hobo/content'
export type { MapDiff }
/** Compute the diff once and hand each layer only its own category. */
export declare const mapDiff: (previous: MapFileV2, next: MapFileV2) => MapDiff
/**
 * Which terrains need their COLLISION rebuilt, and which only their look.
 * Returned separately because the two have very different costs.
 */
export declare function terrainWork(diff: MapDiff): {
  collision: string[]
  appearanceOnly: string[]
  removed: string[]
  added: string[]
}
export declare function staticWork(diff: MapDiff): {
  added: string[]
  removed: string[]
  collision: string[]
  appearanceOnly: string[]
}
export declare class MapLightLayer {
  private readonly scene
  private readonly lights
  constructor(scene: Scene)
  get size(): number
  has(id: string): boolean
  /** Build (or rebuild) every light — boot, and a whole-document replace. */
  reconcile(next: MapFileV2['lights']): void
  /**
   * Only the lights the diff says changed. A texture edit used to make every
   * light in the scene blink, because the whole set was disposed and rebuilt.
   */
  reconcileFromDiff(diff: MapDiff, next: MapFileV2['lights']): void
  private drop
  private create
  dispose(): void
}
/** Dispose meshes whose name matches a prefix + id, for the visual layers. */
export declare function disposeById(scene: Scene, prefix: string, ids: readonly string[]): void
//# sourceMappingURL=mapRuntimeLayers.d.ts.map
