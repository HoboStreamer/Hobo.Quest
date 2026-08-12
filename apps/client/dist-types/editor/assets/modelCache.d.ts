import type { Scene } from '@babylonjs/core/scene.js'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
export interface ModelInstance {
  /** Root of the instantiated hierarchy, ready to parent. */
  root: TransformNode
  dispose: () => void
}
export declare class ModelCache {
  private readonly scene
  private readonly containers
  constructor(scene: Scene)
  get size(): number
  /** Parse a model once; repeat callers share the same in-flight promise. */
  private load
  /**
   * Instantiate one copy. Returns null when the model cannot be parsed, so
   * the caller can raise an Issue instead of leaving a silent hole.
   */
  instantiate(id: string, glb: string): Promise<ModelInstance | null>
  /** Drop a model (deleted import) and everything derived from it. */
  forget(id: string): void
  dispose(): void
}
//# sourceMappingURL=modelCache.d.ts.map
