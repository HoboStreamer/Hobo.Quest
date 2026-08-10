import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import '@babylonjs/core/LensFlares/lensFlareSystemSceneComponent.js'
// LensFlareSystem's occlusion test uses Scene.pick, which requires the Ray
// side-effect module in tree-shaken builds.
import '@babylonjs/core/Culling/ray.js'
import { LensFlare } from '@babylonjs/core/LensFlares/lensFlare.js'
import { LensFlareSystem } from '@babylonjs/core/LensFlares/lensFlareSystem.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import { DefaultRenderingPipeline } from '@babylonjs/core/PostProcesses/RenderPipeline/Pipelines/defaultRenderingPipeline.js'
import type { Camera } from '@babylonjs/core/Cameras/camera.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { SkyMaterial } from '@babylonjs/materials/sky/skyMaterial.js'
import { CloudProceduralTexture } from '@babylonjs/procedural-textures/cloud/cloudProceduralTexture.js'
import type { WaterMaterial } from '@babylonjs/materials/water/waterMaterial.js'

/**
 * Custom sky + time-of-day system: an analytic SkyMaterial dome (Preetham
 * daylight model — real sun disc, dawn/dusk color for free), a drifting
 * procedural cloud layer, a moon that rises when the sun sets, gentle
 * always-lit night, sun lens flares, and town lights that switch on after
 * dark. Everything hangs off ONE DirectionalLight; gameplay code never
 * knows what time it is. (Replaces the atmosphere addon — its dusk band
 * looked muddy and it fought StandardMaterials.)
 */

/** Full day/night cycle length (seconds of real time). */
const DAY_SECONDS = 1200

export class Environment {
  readonly sun: DirectionalLight
  private readonly hemi: HemisphericLight
  private pipeline: DefaultRenderingPipeline | null = null
  private readonly flareEmitter: TransformNode
  private readonly flares: LensFlareSystem
  private readonly skyMat: SkyMaterial
  private readonly clouds: Mesh
  private readonly cloudMat: StandardMaterial
  private readonly moon: Mesh
  private readonly moonMat: StandardMaterial
  private t = DAY_SECONDS * 0.34
  private targetT: number | null = null

  constructor(
    private readonly scene: Scene,
    _engine: AbstractEngine,
  ) {
    this.sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene)
    this.sun.diffuse = new Color3(1, 0.96, 0.88)
    this.hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), scene)
    this.hemi.groundColor = new Color3(0.25, 0.22, 0.2)

    // ── Sky dome (analytic daylight model; renders the actual sun disc) ─
    this.skyMat = new SkyMaterial('sky', scene)
    this.skyMat.backFaceCulling = false
    this.skyMat.useSunPosition = true
    this.skyMat.turbidity = 4.5
    this.skyMat.rayleigh = 2.2
    this.skyMat.mieCoefficient = 0.006
    this.skyMat.mieDirectionalG = 0.82
    this.skyMat.luminance = 1
    const skybox = CreateBox('skybox', { size: 1900 }, scene)
    skybox.material = this.skyMat
    skybox.isPickable = false
    skybox.infiniteDistance = true

    // ── Drifting cloud layer (procedural, transparent over the dome) ────
    const cloudTex = new CloudProceduralTexture('cloud-tex', 1024, scene)
    cloudTex.skyColor = new Color4(0, 0, 0, 0)
    cloudTex.cloudColor = new Color4(1, 1, 1, 0.85)
    this.cloudMat = new StandardMaterial('cloud-mat', scene)
    this.cloudMat.emissiveTexture = cloudTex
    this.cloudMat.opacityTexture = cloudTex
    ;(this.cloudMat.opacityTexture as Texture).getAlphaFromRGB = true
    this.cloudMat.disableLighting = true
    this.cloudMat.backFaceCulling = false
    this.clouds = CreateSphere('clouds', { diameter: 1750, segments: 12, slice: 0.5 }, scene)
    this.clouds.material = this.cloudMat
    this.clouds.isPickable = false
    this.clouds.infiniteDistance = true

    // ── Moon: emissive billboard, rises opposite the sun ────────────────
    this.moonMat = new StandardMaterial('moon-mat', scene)
    this.moonMat.emissiveColor = new Color3(0.9, 0.93, 1)
    this.moonMat.diffuseColor = Color3.Black()
    this.moonMat.disableLighting = true
    this.moonMat.opacityTexture = new Texture(moonTexture(), scene)
    ;(this.moonMat.opacityTexture as Texture).getAlphaFromRGB = true
    this.moon = CreatePlane('moon', { size: 90 }, scene)
    this.moon.material = this.moonMat
    this.moon.billboardMode = Mesh.BILLBOARDMODE_ALL
    this.moon.isPickable = false
    this.moon.infiniteDistance = true

    // ── Sun lens flare (subtle; only when the sun is clearly up) ───────
    this.flareEmitter = new TransformNode('sun-flare-emitter', scene)
    this.flares = new LensFlareSystem('sunFlares', this.flareEmitter, scene)
    const tex = flareTexture()
    new LensFlare(0.16, 0, new Color3(1, 0.95, 0.82), tex, this.flares)
    new LensFlare(0.05, 0.32, new Color3(0.7, 0.85, 1), tex, this.flares)
    new LensFlare(0.08, 0.55, new Color3(1, 0.8, 0.6), tex, this.flares)
    new LensFlare(0.04, 0.8, new Color3(0.65, 0.75, 1), tex, this.flares)
    new LensFlare(0.06, 1.12, new Color3(1, 0.9, 0.75), tex, this.flares)

    // Water reflects the new sky + clouds.
    const waterMesh = scene.getMeshByName('water')
    const waterMat = waterMesh?.material as WaterMaterial | undefined
    if (waterMat && typeof waterMat.addToRenderList === 'function') {
      waterMat.addToRenderList(skybox)
      waterMat.addToRenderList(this.clouds)
    }
  }

  /** Attach the HDR tonemapping pipeline to the active gameplay camera. */
  attachCamera(camera: Camera): void {
    this.pipeline?.dispose()
    this.pipeline = new DefaultRenderingPipeline('env', true, this.scene, [camera])
    this.pipeline.imageProcessingEnabled = true
    this.pipeline.imageProcessing.toneMappingEnabled = true
    this.pipeline.imageProcessing.ditheringEnabled = true
    this.pipeline.imageProcessing.exposure = 1.1
    this.pipeline.fxaaEnabled = true
  }

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
      if (Math.abs(diff) > 60) this.t = (this.targetT + DAY_SECONDS) % DAY_SECONDS
      else this.t = (this.t + diff * Math.min(1, dt * 0.5) + DAY_SECONDS) % DAY_SECONDS
      this.targetT += dt
    }
    const phase = (this.t / DAY_SECONDS) * Math.PI * 2 - Math.PI / 2
    const elevation = Math.sin(phase)
    const azimuth = Math.cos(phase)
    const dir = new Vector3(azimuth * 0.62, -Math.max(elevation, -0.6), 0.45)
    dir.normalize()
    this.sun.direction = dir

    // Sky dome follows the sun; turbidity rises toward dusk for warm haze.
    const sunPos = dir.scale(-800)
    this.skyMat.sunPosition = sunPos
    const dusk = Math.max(0, 1 - Math.abs(elevation) * 5)
    this.skyMat.turbidity = 4.5 + dusk * 5
    this.skyMat.cameraOffset.y = cameraPos.y

    // Light curves: warm days, brief amber dusk, blue moonlit nights.
    const day = Math.max(0, elevation)
    const night = Math.max(0, -elevation)
    this.sun.intensity = day * 1.25 + night * 0.12 + 0.03
    this.sun.diffuse.set(
      1 - night * 0.35,
      0.96 - dusk * 0.22 - night * 0.3,
      0.88 - dusk * 0.4 - night * 0.05,
    )
    this.hemi.intensity = 0.34 + day * 0.5
    this.hemi.diffuse.set(1 - night * 0.25, 1 - night * 0.2, 1)

    // Clouds drift, and fade out at night (they'd glow unrealistically).
    this.clouds.rotation.y += dt * 0.0025
    this.cloudMat.alpha = 0.55 * Math.min(1, 0.15 + day * 1.4)

    // Moon opposite the sun, visible once the sun is low.
    this.moon.position.copyFrom(cameraPos).addInPlace(dir.scale(820))
    this.moonMat.alpha = Math.min(1, Math.max(0, -elevation * 4 + 0.15))

    // Flare emitter rides the sun; only when clearly risen.
    this.flareEmitter.position.copyFrom(cameraPos).addInPlace(sunPos)
    this.flares.isEnabled = elevation > 0.12

    // Town lights: any light named 'lamp:*' fades up after dark.
    const lampGlow = Math.min(1, Math.max(0, 0.15 - elevation) * 6)
    for (const light of this.scene.lights) {
      if (light.name.startsWith('lamp:')) light.intensity = lampGlow * 0.9
    }
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

/** Soft-edged moon disc with a couple of maria smudges. */
function moonTexture(): string {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const g = ctx.createRadialGradient(128, 128, 60, 128, 128, 100)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.85, 'rgba(255,255,255,0.95)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  ctx.fillStyle = 'rgba(160,170,190,0.55)'
  for (const [x, y, r] of [
    [100, 105, 22],
    [150, 140, 16],
    [122, 165, 12],
    [160, 95, 10],
  ] as const) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  return canvas.toDataURL()
}
