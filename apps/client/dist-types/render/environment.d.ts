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
  private pipeline
  private readonly flareEmitter
  private readonly flares
  private readonly skyMat
  private readonly clouds
  private readonly cloudMat
  private readonly moon
  private readonly moonMat
  private t
  private targetT
  constructor(scene: Scene, _engine: AbstractEngine)
  /** Attach the HDR tonemapping pipeline to the active gameplay camera. */
  attachCamera(camera: Camera): void
  /** Sync toward the server's shared day fraction (smoothed, no sun jumps). */
  setDayFraction(frac: number): void
  /** Server-authoritative weather: light/haze/cloud response (render only). */
  private weather
  /** True while the weather system owns scene fog (vs the underwater look). */
  private ownsFog
  /** Set by main each frame; underwater fog wins over weather haze. */
  underwater: boolean
  private weatherDim
  private weatherDimTarget
  private weatherHaze
  private weatherHazeTarget
  private weatherCloud
  private weatherCloudTarget
  setWeather(kind: 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog'): void
  /** Advance time of day; call once per frame. */
  update(dt: number, cameraPos: Vector3): void
}
//# sourceMappingURL=environment.d.ts.map
