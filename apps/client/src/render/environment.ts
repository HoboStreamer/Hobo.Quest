import { Atmosphere } from '@babylonjs/addons/atmosphere'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import '@babylonjs/core/LensFlares/lensFlareSystemSceneComponent.js'
// LensFlareSystem's occlusion test uses Scene.pick, which requires the Ray
// side-effect module in tree-shaken builds.
import '@babylonjs/core/Culling/ray.js'
import { LensFlare } from '@babylonjs/core/LensFlares/lensFlare.js'
import { LensFlareSystem } from '@babylonjs/core/LensFlares/lensFlareSystem.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js'
import type { Camera } from '@babylonjs/core/Cameras/camera.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * Sky, sun and time-of-day: physically based atmosphere (when the engine
 * supports it), an HDR tonemapped pipeline, a slow day/night cycle that
 * never goes fully black, and a lens flare on the sun. Everything hangs off
 * ONE DirectionalLight — gameplay code never knows what time it is.
 */

/** Full day/night cycle length (seconds of real time). */
const DAY_SECONDS = 1200
/** Fraction of the cycle at which the game starts (mid-morning). */
const START_PHASE = 0.34

export class Environment {
  readonly sun: DirectionalLight
  private readonly hemi: HemisphericLight
  private readonly atmosphere: Atmosphere | null = null
  private pipeline: DefaultRenderingPipeline | null = null
  private readonly flareEmitter: TransformNode
  private readonly flares: LensFlareSystem
  private t = DAY_SECONDS * START_PHASE

  constructor(
    private readonly scene: Scene,
    engine: AbstractEngine,
  ) {
    this.sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene)
    this.sun.diffuse = new Color3(1, 0.96, 0.88)
    this.hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), scene)
    this.hemi.groundColor = new Color3(0.25, 0.22, 0.2)

    try {
      if (Atmosphere.IsSupported(engine)) {
        this.atmosphere = new Atmosphere('atmosphere', scene, [this.sun])
        this.atmosphere.isLinearSpaceComposition = true
        // StandardMaterials expect gamma-space light values.
        this.atmosphere.isLinearSpaceLight = false
        // Night keeps a moonlit floor instead of going pitch black.
        this.atmosphere.minimumMultiScatteringIntensity = 0.14
        // Richer dawn/dusk color instead of a grey-brown band.
        this.atmosphere.multiScatteringIntensity = 1.6
      }
    } catch (err) {
      console.warn('atmosphere unavailable, keeping flat sky', err)
    }

    // Sun lens flare: emitter parked far along the sun direction each frame.
    this.flareEmitter = new TransformNode('sun-flare-emitter', scene)
    this.flares = new LensFlareSystem('sunFlares', this.flareEmitter, scene)
    const tex = flareTexture()
    new LensFlare(0.16, 0, new Color3(1, 0.95, 0.82), tex, this.flares)
    new LensFlare(0.05, 0.32, new Color3(0.7, 0.85, 1), tex, this.flares)
    new LensFlare(0.08, 0.55, new Color3(1, 0.8, 0.6), tex, this.flares)
    new LensFlare(0.04, 0.8, new Color3(0.65, 0.75, 1), tex, this.flares)
    new LensFlare(0.06, 1.12, new Color3(1, 0.9, 0.75), tex, this.flares)
  }

  /** Attach the HDR tonemapping pipeline to the active gameplay camera. */
  attachCamera(camera: Camera): void {
    this.pipeline?.dispose()
    this.pipeline = new DefaultRenderingPipeline('env', true, this.scene, [camera])
    this.pipeline.imageProcessingEnabled = true
    this.pipeline.imageProcessing.toneMappingEnabled = true
    this.pipeline.imageProcessing.ditheringEnabled = true
    this.pipeline.imageProcessing.exposure = 1.15
    this.pipeline.fxaaEnabled = true
  }

  private targetT: number | null = null

  /** Sync toward the server's shared day fraction (smoothed, no sun jumps). */
  setDayFraction(frac: number): void {
    this.targetT = frac * DAY_SECONDS
  }

  /** Advance time of day; call once per frame. */
  update(dt: number, cameraPos: Vector3): void {
    this.t = (this.t + dt) % DAY_SECONDS
    if (this.targetT !== null) {
      let diff = this.targetT - this.t
      if (diff > DAY_SECONDS / 2) diff -= DAY_SECONDS
      if (diff < -DAY_SECONDS / 2) diff += DAY_SECONDS
      if (Math.abs(diff) > 60) this.t = this.targetT
      else this.t = (this.t + diff * Math.min(1, dt * 0.5) + DAY_SECONDS) % DAY_SECONDS
      this.targetT += dt
    }
    const phase = (this.t / DAY_SECONDS) * Math.PI * 2 - Math.PI / 2
    // Sun orbit: elevation follows the cycle, azimuth tilted for long shadows.
    const elevation = Math.sin(phase)
    const azimuth = Math.cos(phase)
    const dir = new Vector3(azimuth * 0.62, -Math.max(elevation, -0.35), 0.45)
    dir.normalize()
    this.sun.direction = dir

    // Light curves: daylight rises with sun elevation; night floor keeps
    // the world readable (no pitch-black wilderness).
    const day = Math.max(0, elevation)
    const dusk = Math.max(0, 1 - Math.abs(elevation) * 6) // brief warm band
    this.sun.intensity = day * 1.3 + 0.02
    this.sun.diffuse.set(1, 0.96 - dusk * 0.25, 0.88 - dusk * 0.42)
    this.hemi.intensity = 0.36 + day * 0.5
    this.hemi.diffuse.set(1 - dusk * 0.1, 1 - dusk * 0.16, 1)

    // Flare emitter rides opposite the light direction, far away.
    this.flareEmitter.position.copyFrom(cameraPos).subtractInPlace(dir.scale(450))
    // Flares only when the sun is actually up.
    // Flares only when the sun is clearly up — dusk flares with no visible
    // sun disc read as a bug, not a lens.
    this.flares.isEnabled = elevation > 0.12
  }
}

/** Tiny procedural radial-gradient flare sprite (no asset needed). */
function flareTexture(): string {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.55)')
  g.addColorStop(0.6, 'rgba(255,255,255,0.12)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return canvas.toDataURL()
}
