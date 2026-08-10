import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector2 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import { WaterMaterial } from '@babylonjs/materials/water/waterMaterial.js'
import { WATER_LEVEL } from '@hobo/content'

/**
 * The island's water: ONE animated reflective sheet at WATER_LEVEL —
 * terrain dips below it become lakes, and past the map edge it reads as
 * the open ocean. Reflection/refraction sample the real scene (terrain,
 * city, props), driven by Babylon's WaterMaterial and the official
 * waterbump normal texture. Deeper systems (shore foam, underwater fog,
 * swimming) layer on later — this is the v1 the rest builds on.
 */
export class Water {
  readonly material: WaterMaterial
  private readonly mesh: Mesh

  constructor(scene: Scene) {
    this.mesh = CreateGround('water', { width: 1600, height: 1600, subdivisions: 32 }, scene)
    this.mesh.position.y = WATER_LEVEL
    this.mesh.isPickable = false

    const water = new WaterMaterial('water', scene, new Vector2(512, 512))
    water.bumpTexture = new Texture('/assets/tex/waterbump.png', scene)
    water.windForce = 6
    water.waveHeight = 0.06
    water.bumpHeight = 0.25
    water.waveLength = 0.35
    water.windDirection = new Vector2(1, 0.35)
    water.waterColor = new Color3(0.12, 0.3, 0.35)
    water.colorBlendFactor = 0.5
    // Visible from BELOW too — the surface must exist when submerged.
    water.backFaceCulling = false
    this.material = water
    this.mesh.material = water
  }

  /** Meshes the water reflects/refracts (terrain, statics, skirt...). */
  addToRenderList(mesh: AbstractMesh): void {
    this.material.addToRenderList(mesh)
  }

  /**
   * A still-water material (fountain pools, troughs): animated ripples via
   * the bump texture only — zero wave displacement, which shreds small
   * low-tessellation surfaces into spikes.
   */
  makeCalmSurface(name: string): WaterMaterial {
    const scene = this.mesh.getScene()
    const calm = new WaterMaterial(name, scene, new Vector2(128, 128))
    calm.bumpTexture = new Texture('/assets/tex/waterbump.png', scene)
    calm.windForce = 1.5
    calm.waveHeight = 0
    calm.bumpHeight = 0.3
    calm.waveLength = 0.08
    calm.windDirection = new Vector2(0.7, 0.7)
    calm.waterColor = new Color3(0.1, 0.25, 0.3)
    calm.colorBlendFactor = 0.45
    return calm
  }
}
