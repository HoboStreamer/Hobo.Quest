/**
 * Imported-model cache.
 *
 * Every placed instance used to call `SceneLoader.ImportMeshAsync` with the
 * model's data URL, so ten copies of a prop parsed the same glTF ten times —
 * on a data URL, which means base64-decoding megabytes each time too.
 *
 * A model is now parsed ONCE into an `AssetContainer` and each instance is
 * `instantiateModelsToScene`, which shares geometry and materials. Concurrent
 * requests for the same model await the same promise rather than racing.
 */
import type { AssetContainer } from '@babylonjs/core/assetContainer.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'

export interface ModelInstance {
  /** Root of the instantiated hierarchy, ready to parent. */
  root: TransformNode
  dispose: () => void
}

export class ModelCache {
  private readonly containers = new Map<string, Promise<AssetContainer | null>>()

  constructor(private readonly scene: Scene) {}

  get size(): number {
    return this.containers.size
  }

  /** Parse a model once; repeat callers share the same in-flight promise. */
  private load(id: string, glb: string): Promise<AssetContainer | null> {
    const existing = this.containers.get(id)
    if (existing) return existing
    const p = (async (): Promise<AssetContainer | null> => {
      try {
        const { LoadAssetContainerAsync } = await import('@babylonjs/core/Loading/sceneLoader.js')
        await import('@babylonjs/loaders/glTF/2.0/glTFLoader.js')
        return await LoadAssetContainerAsync(glb, this.scene, { pluginExtension: '.glb' })
      } catch {
        return null
      }
    })()
    this.containers.set(id, p)
    return p
  }

  /**
   * Instantiate one copy. Returns null when the model cannot be parsed, so
   * the caller can raise an Issue instead of leaving a silent hole.
   */
  async instantiate(id: string, glb: string): Promise<ModelInstance | null> {
    const container = await this.load(id, glb)
    if (!container) return null
    const entries = container.instantiateModelsToScene(undefined, false, {
      doNotInstantiate: false,
    })
    const root = entries.rootNodes[0] as TransformNode | undefined
    if (!root) {
      entries.dispose()
      return null
    }
    return { root, dispose: () => entries.dispose() }
  }

  /** Drop a model (deleted import) and everything derived from it. */
  forget(id: string): void {
    const p = this.containers.get(id)
    this.containers.delete(id)
    void p?.then((c) => c?.dispose())
  }

  dispose(): void {
    for (const id of [...this.containers.keys()]) this.forget(id)
  }
}
