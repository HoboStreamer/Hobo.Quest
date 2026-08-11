/**
 * The renderer for a layered surface: one base texture plus up to four paint
 * layers blended by the RGBA channels of a single mask.
 *
 * Built on Babylon's `CustomMaterial`, which extends StandardMaterial and
 * lets us inject GLSL at `CUSTOM_FRAGMENT_UPDATE_DIFFUSE`. That matters:
 * lighting, shadows, fog and the day/night rig keep working exactly as they
 * do for every other surface in the game, and the SAME material class runs in
 * the editor and in play — so painting is WYSIWYG rather than an editor-only
 * approximation.
 *
 * Replaces TerrainMaterial, whose three diffuse slots were hard-wired to
 * grass/rock/mud and which had no concept of a base texture at all.
 */
import { CustomMaterial } from '@babylonjs/materials/custom/customMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { type SurfaceMaterialData } from '@hobo/content'
export interface LayeredSurfaceOptions {
  /** UV tiles across the surface for the BASE texture. */
  baseTiling?: number
  /** Default tiling for layers that do not specify their own. */
  layerTiling?: number
  backFaceCulling?: boolean
}
/**
 * A material bound to one surface's data. `update()` re-reads the data, so a
 * paint stroke or a base-texture change never needs the mesh rebuilt.
 */
export declare class LayeredSurfaceMaterial {
  private readonly scene
  private data
  private readonly opts
  readonly material: CustomMaterial
  private layerTextures
  private maskTexture
  private readonly fallbackMask
  constructor(scene: Scene, name: string, data: SurfaceMaterialData, opts?: LayeredSurfaceOptions)
  get surface(): SurfaceMaterialData
  /** Point the mask sampler at a live canvas texture (the editor's brush). */
  setMaskTexture(tex: Texture | null): void
  update(data: SurfaceMaterialData): void
  private scales
  private enabled
  private bind
  dispose(): void
}
/** Load a persisted mask image (data URL or /map-assets path) as a texture. */
export declare function maskTextureFrom(scene: Scene, mask: string | undefined): Texture | null
//# sourceMappingURL=layeredSurface.d.ts.map
