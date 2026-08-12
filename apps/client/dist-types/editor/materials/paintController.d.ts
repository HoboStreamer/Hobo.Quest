import type { Scene } from '@babylonjs/core/scene.js'
import { type SurfaceMaterialData } from '@hobo/content'
import type { EditorDocument } from '../document/editorDocument.js'
import type { EditorViewRegistry } from '../viewport/editorViewRegistry.js'
import { type PaintUV, type ProjectionMode } from './paintableSurface.js'
import type { PaintSurfaceRegistry, PaintSurfaceState } from './paintSurfaceRegistry.js'
export interface PaintHit {
  ownerId: string
  surfaceId: string
  projection: ProjectionMode
  uv: PaintUV
  /** Live mask state for this exact surface. */
  state: PaintSurfaceState
  /** The authored surface data as the document currently holds it. */
  data: SurfaceMaterialData
}
export interface PaintControllerOptions {
  scene: Scene
  doc: EditorDocument
  views: EditorViewRegistry
  registry: PaintSurfaceRegistry
  newId: (prefix: string) => string
}
/**
 * The surface data for (owner, surface), defaulted so that painting a
 * never-painted object PRESERVES how it already looks.
 *
 * A legacy static carries `color` / `tex` / `uv` / `faces`; a legacy terrain
 * carries `tex` / `color`. Those become the BASE of the v2 surface on first
 * paint, so the first brush stroke adds coverage on top of the existing
 * appearance instead of resetting the object to grey.
 */
export declare function surfaceDataFor(
  doc: EditorDocument,
  ownerId: string,
  surfaceId: string,
): SurfaceMaterialData
/** Write surface data back to the right place for the owner's kind. */
export declare function writeSurfaceData(
  doc: EditorDocument,
  ownerId: string,
  surfaceId: string,
  data: SurfaceMaterialData,
): void
export declare class PaintController {
  private readonly opts
  constructor(opts: PaintControllerOptions)
  /**
   * Resolve whatever is under the cursor into a paint target, or null.
   *
   * The owning object comes from the view registry (stable document id), NOT
   * from a Babylon mesh name — instance names vary between loads, so identity
   * inferred from one would not survive a reload.
   */
  hitTest(brushRadius: number): PaintHit | null
  private terrainHit
  private staticHit
  /**
   * Allocate (or reuse) the layer the brush paints into, writing the result
   * to the document so a new layer is itself part of the map.
   *
   * Returns null at the layer budget rather than swapping a texture out —
   * silently replacing someone's paint is the behaviour the layered surface
   * model was built to end.
   */
  ensureLayer(
    hit: PaintHit,
    tex: string,
    tint: string | undefined,
  ): {
    channel: string
    data: SurfaceMaterialData
  } | null
  get layerBudget(): number
}
//# sourceMappingURL=paintController.d.ts.map
