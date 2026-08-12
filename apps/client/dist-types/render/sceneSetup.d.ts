import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { Scene } from '@babylonjs/core/scene.js'
import { type ContentRegistry, type MapTextureEntry, type WorldShape } from '@hobo/content'
import { Water } from './water.js'
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
export declare function buildStaticWorld(scene: Scene, content: ContentRegistry): void
/**
 * The MAP's statics, rendered under their stable ids in their own layer.
 * They used to be pushed into `content.world.statics` at boot, which merged
 * authored geometry into base content permanently — so a live save could add
 * a mesh but never move or remove one, and re-applying a map drew a second
 * copy on top of the first.
 */
export declare function buildMapStaticVisuals(scene: Scene, water?: Water): void
/** Live map save: replace the map-static layer, leaving base content alone. */
export declare function rebuildMapStaticVisuals(scene: Scene): void
/** Live map edit: replace the rendered terrain with the new grid + paint. */
export declare function rebuildTerrainVisual(scene: Scene, content: ContentRegistry): void
//# sourceMappingURL=sceneSetup.d.ts.map
