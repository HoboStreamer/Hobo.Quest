/**
 * The renderer for a layered surface: one base texture plus up to four paint
 * layers blended by the RGBA channels of a single mask.
 *
 * Built on Babylon's `CustomMaterial`, which extends StandardMaterial and
 * lets us inject GLSL at `CUSTOM_FRAGMENT_UPDATE_DIFFUSE`. That matters:
 * lighting, shadows, fog and the day/night rig keep working exactly as they
 * do for every other surface in the game, and the SAME material class runs in
 * the editor and in play — so painting is WYSIWYG rather than an editor-only
 * approximation.
 *
 * Replaces TerrainMaterial, whose three diffuse slots were hard-wired to
 * grass/rock/mud and which had no concept of a base texture at all.
 */
import { CustomMaterial } from '@babylonjs/materials/custom/customMaterial.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture.js'
import { Engine } from '@babylonjs/core/Engines/engine.js'
import type { Scene } from '@babylonjs/core/scene.js'
import {
  MAX_PAINT_LAYERS,
  PAINT_CHANNELS,
  activeLayers,
  type SurfaceMaterialData,
} from '@hobo/content'
import { resolveTexInfo } from './mapStyle.js'

/** A 1×1 white texture stands in for "no base texture" so the shader always
 *  has a diffuse sampler (and therefore vDiffuseUV) to work with. */
const whitePixels = new WeakMap<Scene, RawTexture>()
function white(scene: Scene): Texture {
  let whitePixel = whitePixels.get(scene)
  if (!whitePixel) {
    whitePixel = RawTexture.CreateRGBATexture(
      new Uint8Array([255, 255, 255, 255]),
      1,
      1,
      scene,
      false,
      false,
      Engine.TEXTURE_NEAREST_SAMPLINGMODE,
    )
    whitePixel.name = 'hobo:white'
    whitePixels.set(scene, whitePixel)
  }
  return whitePixel
}

/** A fully transparent mask: nothing painted, base shows everywhere. */
function emptyMask(scene: Scene): Texture {
  const t = RawTexture.CreateRGBATexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
    scene,
    false,
    false,
    Engine.TEXTURE_NEAREST_SAMPLINGMODE,
  )
  t.name = 'hobo:emptymask'
  return t
}

const FRAGMENT_BLEND = `
  // Coverage for up to four paint layers, packed into one RGBA mask.
  vec4 hoboCoverage = texture2D(hoboMask, vDiffuseUV);
  vec3 hoboBase = baseColor.rgb;
  hoboBase = mix(hoboBase, texture2D(hoboLayer0, vDiffuseUV * hoboScale.x).rgb, hoboCoverage.r * hoboEnabled.x);
  hoboBase = mix(hoboBase, texture2D(hoboLayer1, vDiffuseUV * hoboScale.y).rgb, hoboCoverage.g * hoboEnabled.y);
  hoboBase = mix(hoboBase, texture2D(hoboLayer2, vDiffuseUV * hoboScale.z).rgb, hoboCoverage.b * hoboEnabled.z);
  hoboBase = mix(hoboBase, texture2D(hoboLayer3, vDiffuseUV * hoboScale.w).rgb, hoboCoverage.a * hoboEnabled.w);
  baseColor.rgb = hoboBase;
`

export interface LayeredSurfaceOptions {
  /** UV tiles across the surface for the BASE texture. */
  baseTiling?: number
  /** Default tiling for layers that do not specify their own. */
  layerTiling?: number
  backFaceCulling?: boolean
}

/**
 * A material bound to one surface's data. `update()` re-reads the data, so a
 * paint stroke or a base-texture change never needs the mesh rebuilt.
 */
export class LayeredSurfaceMaterial {
  readonly material: CustomMaterial
  private layerTextures: (Texture | null)[] = [null, null, null, null]
  private maskTexture: Texture | null = null
  private readonly fallbackMask: Texture

  constructor(
    private readonly scene: Scene,
    name: string,
    private data: SurfaceMaterialData,
    private readonly opts: LayeredSurfaceOptions = {},
  ) {
    const m = new CustomMaterial(name, scene)
    m.specularColor = new Color3(0.02, 0.02, 0.02)
    m.backFaceCulling = opts.backFaceCulling ?? true
    m.AddUniform('hoboMask', 'sampler2D', null)
    for (let i = 0; i < MAX_PAINT_LAYERS; i++) m.AddUniform(`hoboLayer${i}`, 'sampler2D', null)
    // xyzw = per-layer UV tiling; hoboEnabled gates unused slots to 0 so an
    // unbound sampler can never bleed through.
    m.AddUniform('hoboScale', 'vec4', null)
    m.AddUniform('hoboEnabled', 'vec4', null)
    m.Fragment_Custom_Diffuse(FRAGMENT_BLEND)
    this.material = m
    this.fallbackMask = emptyMask(scene)
    this.update(data)
  }

  get surface(): SurfaceMaterialData {
    return this.data
  }

  /** Point the mask sampler at a live canvas texture (the editor's brush). */
  setMaskTexture(tex: Texture | null): void {
    this.maskTexture = tex
    this.bind()
  }

  update(data: SurfaceMaterialData): void {
    this.data = data
    const m = this.material

    // ── Base: the surface's own texture/colour, untouched by painting. ──
    const baseInfo = data.base.tex ? resolveTexInfo(data.base.tex) : null
    m.diffuseTexture?.dispose()
    if (baseInfo) {
      const tx = new Texture(baseInfo.url, this.scene)
      const tiles = this.opts.baseTiling ?? 1
      tx.uScale = tx.vScale = tiles
      m.diffuseTexture = tx
    } else {
      // Plain-colour base still needs a diffuse sampler for vDiffuseUV.
      m.diffuseTexture = white(this.scene)
    }
    m.diffuseColor = data.base.color
      ? Color3.FromHexString(data.base.color)
      : new Color3(0.85, 0.85, 0.85)

    // ── Layers ──────────────────────────────────────────────────────────
    for (const t of this.layerTextures) t?.dispose()
    this.layerTextures = [null, null, null, null]
    const scales: number[] = [1, 1, 1, 1]
    const enabled: number[] = [0, 0, 0, 0]
    for (const layer of activeLayers(data.paint)) {
      const idx = PAINT_CHANNELS.indexOf(layer.channel)
      if (idx < 0) continue
      const info = resolveTexInfo(layer.tex)
      if (!info) continue
      const tx = new Texture(info.url, this.scene)
      const tiles = layer.scale ?? this.opts.layerTiling ?? 8
      tx.uScale = tx.vScale = 1
      this.layerTextures[idx] = tx
      scales[idx] = tiles
      enabled[idx] = 1
    }
    this.scales = scales
    this.enabled = enabled
    this.bind()
  }

  private scales: number[] = [1, 1, 1, 1]
  private enabled: number[] = [0, 0, 0, 0]

  private bind(): void {
    const m = this.material
    m.onBindObservable.clear()
    m.onBindObservable.add(() => {
      const effect = m.getEffect()
      if (!effect) return
      effect.setTexture('hoboMask', this.maskTexture ?? this.fallbackMask)
      for (let i = 0; i < MAX_PAINT_LAYERS; i++)
        effect.setTexture(`hoboLayer${i}`, this.layerTextures[i] ?? this.fallbackMask)
      effect.setFloat4(
        'hoboScale',
        this.scales[0]!,
        this.scales[1]!,
        this.scales[2]!,
        this.scales[3]!,
      )
      effect.setFloat4(
        'hoboEnabled',
        this.enabled[0]!,
        this.enabled[1]!,
        this.enabled[2]!,
        this.enabled[3]!,
      )
    })
  }

  dispose(): void {
    for (const t of this.layerTextures) t?.dispose()
    this.fallbackMask.dispose()
    this.material.dispose()
  }
}

/** Load a persisted mask image (data URL or /map-assets path) as a texture. */
export function maskTextureFrom(scene: Scene, mask: string | undefined): Texture | null {
  if (!mask) return null
  const t = new Texture(mask, scene, true, false)
  t.wrapU = Texture.CLAMP_ADDRESSMODE
  t.wrapV = Texture.CLAMP_ADDRESSMODE
  return t
}
