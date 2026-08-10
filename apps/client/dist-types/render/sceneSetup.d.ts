import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { Scene } from '@babylonjs/core/scene.js'
import { type ContentRegistry, type WorldShape } from '@hobo/content'
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
/** Builds render meshes for the static level (mirrors the server's physics statics). */
export declare function buildStaticWorld(
  scene: Scene,
  content: ContentRegistry,
  mapMix?: string,
): void
//# sourceMappingURL=sceneSetup.d.ts.map
