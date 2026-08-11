import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { SpotLight } from '@babylonjs/core/Lights/spotLight.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { RectAreaLight } from '@babylonjs/core/Lights/rectAreaLight.js'
import { ShadowGenerator } from '@babylonjs/core/Lights/Shadows/shadowGenerator.js'
import type { Light } from '@babylonjs/core/Lights/light.js'
import type { IShadowLight } from '@babylonjs/core/Lights/shadowLight.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { FaceStyle, MapLight, MapTextureEntry, WorldShape } from '@hobo/content'

/**
 * Shared surface-styling + lighting for editor AND game: custom texture
 * registry (server-hosted or embedded), Hammer-style per-face materials on
 * box statics, and editor-placed map lights (all five Babylon light types,
 * optional shadow generators). Both scenes call the same functions so what
 * you see in the editor is what ships in game.
 */

export interface CustomTexInfo {
  url: string
  /** World meters covered by one texture tile (default 2). */
  scale?: number
}

const customTextures = new Map<string, CustomTexInfo>()

export function registerCustomTextures(entries: MapTextureEntry[] | undefined): void {
  customTextures.clear()
  for (const t of entries ?? []) {
    const url = t.url ?? t.dataUrl
    if (url) customTextures.set(t.name, { url, ...(t.scale ? { scale: t.scale } : {}) })
  }
}

/** Resolve a texture reference ('red_brick' | 'custom:<name>' | 'none'). */
export function resolveTexInfo(name: string | undefined): CustomTexInfo | null {
  if (!name || name === 'none') return null
  if (name.startsWith('custom:')) return customTextures.get(name.slice(7)) ?? null
  return { url: `/assets/tex/${name}.jpg` }
}

/** 'red_brick_diff_4k' → 'Red Brick' (display name, no prefixes/suffixes). */
export function prettyTexName(name: string): string {
  const base = name.startsWith('custom:') ? name.slice(7) : name
  return base
    .replace(/_(diff|albedo|color|basecolor|col)(_\d+k)?$/i, '')
    .replace(/_\d+k$/i, '')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

interface StyledBody {
  shape: WorldShape
  color: string
  tex?: string | undefined
  uv?: FaceStyle | undefined
  faces?: Record<string, FaceStyle> | undefined
}

/** [u meters, v meters] the texture must span for a given surface. */
function surfaceDims(shape: WorldShape, face?: number): [number, number] {
  if (shape.type === 'box') {
    const [w, h, d] = shape.size
    if (face === undefined) return [Math.max(w, d), h]
    if (face === 0 || face === 1) return [w, h]
    if (face === 2 || face === 3) return [d, h]
    return [w, d]
  }
  if (shape.type === 'cylinder') return [shape.radius * 2 * Math.PI, shape.height]
  return [shape.radius * 2 * Math.PI, shape.radius * Math.PI]
}

function styledTexture(
  scene: Scene,
  info: CustomTexInfo,
  style: FaceStyle,
  dims: [number, number],
): Texture {
  const tx = new Texture(info.url, scene)
  const tile = info.scale ?? 2 // meters per tile
  tx.uScale = style.sx && style.sx > 0 ? style.sx : Math.max(0.25, dims[0] / tile)
  tx.vScale = style.sy && style.sy > 0 ? style.sy : Math.max(0.25, dims[1] / tile)
  if (style.ox) tx.uOffset = style.ox
  if (style.oy) tx.vOffset = style.oy
  if (style.rot) {
    tx.wAng = style.rot
    tx.uRotationCenter = 0.5
    tx.vRotationCenter = 0.5
  }
  return tx
}

function faceMaterial(
  scene: Scene,
  name: string,
  body: StyledBody,
  style: FaceStyle,
  dims: [number, number],
): StandardMaterial {
  const mat = new StandardMaterial(name, scene)
  mat.maxSimultaneousLights = 8
  const info = resolveTexInfo(style.tex)
  if (info) {
    mat.diffuseTexture = styledTexture(scene, info, style, dims)
    // Mostly let the texture speak — a heavy tint multiplies photos into mud.
    const tint = style.color ?? body.color
    mat.diffuseColor = Color3.Lerp(Color3.FromHexString(tint), Color3.White(), 0.75)
    mat.specularColor = new Color3(0.04, 0.04, 0.04)
  } else {
    mat.diffuseColor = Color3.FromHexString(style.color ?? body.color)
    mat.specularColor = new Color3(0.08, 0.08, 0.08)
  }
  return mat
}

/** Merge whole-body style with a per-face override (face wins per key). */
function mergedStyle(body: StyledBody, face?: FaceStyle): FaceStyle {
  const base: FaceStyle = { ...(body.tex ? { tex: body.tex } : {}), ...(body.uv ?? {}) }
  if (!face) return base
  return { ...base, ...face }
}

/**
 * Apply the body's surface styling (texture/uv/per-face) to its mesh.
 * Plain-color bodies keep their shared cached material — zero cost.
 */
export function applyStaticStyle(scene: Scene, mesh: Mesh, s: StyledBody): void {
  const faceKeys = s.faces ? Object.keys(s.faces) : []
  const hasFaces = s.shape.type === 'box' && faceKeys.length > 0
  if (!hasFaces) {
    const style = mergedStyle(s)
    if (!resolveTexInfo(style.tex)) return // plain color — cached material stays
    mesh.material = faceMaterial(scene, `style:${mesh.name}`, s, style, surfaceDims(s.shape))
    return
  }
  // Box with per-face styles: 6 submeshes + a MultiMaterial (Hammer-style).
  const multi = new MultiMaterial(`faces:${mesh.name}`, scene)
  for (let f = 0; f < 6; f++) {
    const style = mergedStyle(s, s.faces![String(f)])
    multi.subMaterials.push(
      faceMaterial(scene, `face:${mesh.name}:${f}`, s, style, surfaceDims(s.shape, f)),
    )
  }
  mesh.subMeshes = []
  const total = mesh.getTotalVertices()
  for (let f = 0; f < 6; f++) new SubMesh(f, 0, total, f * 6, 6, mesh)
  mesh.material = multi
}

/**
 * Terrain patch tiling: default keeps the classic ~4m tile; custom
 * textures honor their own meters-per-tile scale; uv overrides win.
 */
export function applyPatchTexture(
  tx: Texture,
  halfExtent: number,
  info: CustomTexInfo,
  uv?: FaceStyle,
): void {
  const tile = info.scale ?? 4
  tx.uScale = uv?.sx && uv.sx > 0 ? uv.sx : Math.max(2, (halfExtent * 2) / tile)
  tx.vScale = uv?.sy && uv.sy > 0 ? uv.sy : Math.max(2, (halfExtent * 2) / tile)
  if (uv?.ox) tx.uOffset = uv.ox
  if (uv?.oy) tx.vOffset = uv.oy
  if (uv?.rot) {
    tx.wAng = uv.rot
    tx.uRotationCenter = 0.5
    tx.vRotationCenter = 0.5
  }
}

// ── Map lights ────────────────────────────────────────────────────────
const liveLights = new Map<Scene, { lights: Light[]; gens: ShadowGenerator[] }>()

export const LIGHT_DEFAULTS = {
  color: '#ffffff',
  intensity: { point: 0.8, spot: 1.2, directional: 0.5, hemi: 0.4, rect: 1.0 },
  range: 24,
  angle: Math.PI / 3,
  exponent: 2,
  ground: '#2a2a35',
  size: [4, 2] as [number, number],
}

/** Instantiate ONE map light (editor uses this for live preview too). */
export function instantiateMapLight(scene: Scene, l: MapLight): Light | null {
  const pos = new Vector3(l.pos[0], l.pos[1], l.pos[2])
  const dir = l.dir ? new Vector3(l.dir[0], l.dir[1], l.dir[2]).normalize() : new Vector3(0, -1, 0)
  let light: Light
  switch (l.type) {
    case 'point':
      light = new PointLight(`maplight:${l.id}`, pos, scene)
      ;(light as PointLight).range = l.range ?? LIGHT_DEFAULTS.range
      break
    case 'spot': {
      const s = new SpotLight(
        `maplight:${l.id}`,
        pos,
        dir,
        l.angle ?? LIGHT_DEFAULTS.angle,
        l.exponent ?? LIGHT_DEFAULTS.exponent,
        scene,
      )
      s.range = l.range ?? LIGHT_DEFAULTS.range
      light = s
      break
    }
    case 'directional': {
      const d = new DirectionalLight(`maplight:${l.id}`, dir, scene)
      d.position = pos
      light = d
      break
    }
    case 'hemi': {
      // Hemi direction points at the sky the light bounces FROM.
      const h = new HemisphericLight(`maplight:${l.id}`, dir.scale(-1), scene)
      h.groundColor = Color3.FromHexString(l.ground ?? LIGHT_DEFAULTS.ground)
      light = h
      break
    }
    case 'rect': {
      const size = l.size ?? LIGHT_DEFAULTS.size
      const r = new RectAreaLight(`maplight:${l.id}`, pos, size[0], size[1], scene)
      // RectAreaLight emits toward -Z; orient the node toward `dir`.
      light = r
      break
    }
    default:
      return null
  }
  light.diffuse = Color3.FromHexString(l.color ?? LIGHT_DEFAULTS.color)
  light.specular = Color3.FromHexString(l.specular ?? l.color ?? LIGHT_DEFAULTS.color)
  light.intensity = l.intensity ?? LIGHT_DEFAULTS.intensity[l.type]
  return light
}

/**
 * (Re)build all editor-placed lights for a scene. Shadow generators are
 * capped (they're expensive) and attach every static/patch as caster.
 */
export function buildMapLights(scene: Scene, lights: MapLight[] | undefined): void {
  disposeMapLights(scene)
  const entry = { lights: [] as Light[], gens: [] as ShadowGenerator[] }
  liveLights.set(scene, entry)
  let shadowBudget = 3
  for (const l of (lights ?? []).slice(0, 24)) {
    const light = instantiateMapLight(scene, l)
    if (!light) continue
    entry.lights.push(light)
    const shadowable = l.type === 'spot' || l.type === 'directional' || l.type === 'point'
    if (l.shadows && shadowable && shadowBudget > 0) {
      shadowBudget--
      const gen = new ShadowGenerator(1024, light as unknown as IShadowLight)
      gen.useBlurExponentialShadowMap = true
      gen.blurKernel = 16
      for (const m of scene.meshes) {
        const n = m.name
        if (n.startsWith('static:') || n.startsWith('s:') || n.startsWith('patch:')) {
          gen.addShadowCaster(m as Mesh, true)
          m.receiveShadows = true
        }
        if (n === 'terrain') m.receiveShadows = true
      }
      entry.gens.push(gen)
    }
  }
}

export function disposeMapLights(scene: Scene): void {
  const entry = liveLights.get(scene)
  if (!entry) return
  for (const g of entry.gens) g.dispose()
  for (const l of entry.lights) l.dispose()
  liveLights.delete(scene)
}
