import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import '@babylonjs/core/LensFlares/lensFlareSystemSceneComponent.js'
import '@babylonjs/core/Culling/ray.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Camera } from '@babylonjs/core/Cameras/camera.js'
import type { Scene } from '@babylonjs/core/scene.js'
export declare class Environment {
  private readonly scene
  readonly sun: DirectionalLight
  private readonly hemi
  private readonly atmosphere
  private pipeline
  private readonly flareEmitter
  private readonly flares
  private t
  constructor(scene: Scene, engine: AbstractEngine)
  /** Attach the HDR tonemapping pipeline to the active gameplay camera. */
  attachCamera(camera: Camera): void
  /** Advance time of day; call once per frame. */
  update(dt: number, cameraPos: Vector3): void
}
//# sourceMappingURL=environment.d.ts.map
