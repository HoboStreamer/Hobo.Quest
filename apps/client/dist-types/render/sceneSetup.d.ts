import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { Scene } from '@babylonjs/core/scene.js'
import { type ContentRegistry, type MapTextureEntry, type WorldShape } from '@hobo/content'
/**
 * Engine + scene bootstrap and static world construction. WebGPU when the
 * browser supports it, WebGL otherwise — nothing else in the client cares
 * which one is active.
 */
export declare function createEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine>
export declare function createScene(engine: AbstractEngine): Scene
export declare function materialFor(scene: Scene, hex: string): StandardMaterial
export declare function meshForShape(
  scene: Scene,
  name: string,
  shape: WorldShape,
  color: string,
): Mesh
export declare function registerMapAssets(
  map: {
    textures?: MapTextureEntry[]
    models?: {
      id: string
      name: string
      glb: string
      bounds: [number, number, number]
    }[]
  } | null,
): void
export declare function buildTerrainPatches(scene: Scene, content: ContentRegistry): Mesh[]
export declare function rebuildTerrainPatchVisuals(scene: Scene, content: ContentRegistry): void
export declare function buildStaticWorld(
  scene: Scene,
  content: ContentRegistry,
  mapMix?: string,
): void
/** Live map edit: replace the rendered terrain with the new grid + paint. */
export declare function rebuildTerrainVisual(
  scene: Scene,
  content: ContentRegistry,
  mix?: string,
): void
//# sourceMappingURL=sceneSetup.d.ts.map
