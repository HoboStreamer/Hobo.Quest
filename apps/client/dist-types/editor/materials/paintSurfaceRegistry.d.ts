/**
 * Live paint state, keyed by (object id, surface id).
 *
 * Terrain used to keep its one mask on `TerrainView`, and the whole paint
 * path was written against that: pick a terrain, reach into the view, stamp
 * its mask. Nothing else could be painted because nothing else had one.
 *
 * A box has six independently paintable faces, a cylinder and a sphere have
 * their own wraps, and an imported model has a slot per material — so a mask
 * belongs to a SURFACE, not to a view, and the pair (owner, surface) is the
 * key. That pair is also what history and the save path address, so a stroke
 * is undoable and persistable without anything having to know which kind of
 * object it landed on.
 *
 * The registry holds runtime state only. The authored data — layers, tints,
 * the mask's URL — lives in the document, as always.
 */
import type { Scene } from '@babylonjs/core/scene.js'
import type { SurfaceMaterialData } from '@hobo/content'
import { PaintMask } from './paintMask.js'
/** A surface's live mask plus whether it needs uploading. */
export interface PaintSurfaceState {
  ownerId: string
  surfaceId: string
  mask: PaintMask
  /**
   * True once a stroke has changed the mask since the persisted reference
   * was written. Save uploads only these, so an unchanged mask costs no
   * HTTP request at all — server-side dedupe would still cost the round
   * trip and the PNG encode.
   */
  dirty: boolean
  /** The mask URL the document currently holds, if any. */
  persistedRef: string | null
}
export declare const surfaceKey: (ownerId: string, surfaceId: string) => string
export declare class PaintSurfaceRegistry {
  private readonly scene
  private readonly surfaces
  constructor(scene: Scene)
  get size(): number
  /** Every live surface, for the save path. */
  all(): PaintSurfaceState[]
  peek(ownerId: string, surfaceId: string): PaintSurfaceState | null
  /**
   * The mask for a surface, created on first use and seeded from whatever
   * the document already persisted. Lazy because a map with a thousand
   * statics must not allocate a thousand 512² canvases to open.
   */
  ensure(ownerId: string, surfaceId: string, data: SurfaceMaterialData): PaintSurfaceState
  /** A stroke finished: this surface now differs from what was persisted. */
  markDirty(ownerId: string, surfaceId: string): void
  /** The save path wrote this URL; the mask matches it again. */
  markPersisted(ownerId: string, surfaceId: string, ref: string): void
  /** Surfaces whose mask has changed since it was last written. */
  dirtySurfaces(): PaintSurfaceState[]
  /** Drop everything belonging to an object whose view went away. */
  disposeOwner(ownerId: string): void
  disposeAll(): void
}
//# sourceMappingURL=paintSurfaceRegistry.d.ts.map
