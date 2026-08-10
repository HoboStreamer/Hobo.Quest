import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { WaterMaterial } from '@babylonjs/materials/water/waterMaterial.js'
/**
 * The island's water: ONE animated reflective sheet at WATER_LEVEL —
 * terrain dips below it become lakes, and past the map edge it reads as
 * the open ocean. Reflection/refraction sample the real scene (terrain,
 * city, props), driven by Babylon's WaterMaterial and the official
 * waterbump normal texture. Deeper systems (shore foam, underwater fog,
 * swimming) layer on later — this is the v1 the rest builds on.
 */
export declare class Water {
  readonly material: WaterMaterial
  private readonly mesh
  constructor(scene: Scene)
  /** Meshes the water reflects/refracts (terrain, statics, skirt...). */
  addToRenderList(mesh: AbstractMesh): void
  /**
   * A still-water material (fountain pools, troughs): animated ripples via
   * the bump texture only — zero wave displacement, which shreds small
   * low-tessellation surfaces into spikes.
   */
  makeCalmSurface(name: string): WaterMaterial
}
//# sourceMappingURL=water.d.ts.map
