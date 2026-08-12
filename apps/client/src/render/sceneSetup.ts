import { Engine } from '@babylonjs/core/Engines/engine.js'
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Quaternion } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import { Scene } from '@babylonjs/core/scene.js'
import { LayeredSurfaceMaterial, maskTextureFrom } from './layeredSurface.js'
import { applyPaintedStatic, createModelPaintOverlay } from './paintedStatic.js'
import { ModelCache } from './modelCache.js'
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { Color4 as BColor4 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import {
  buildPatchGrid,
  buildTerrainGrid,
  getMapOverride,
  type ContentRegistry,
  type MapTextureEntry,
  type WorldShape,
  type StaticBody,
  effectiveShape,
  migrateLegacyMix,
  type SurfaceMaterialData,
  type StaticObjectV2,
} from '@hobo/content'
import { Water } from './water.js'
import {
  applyPatchTexture,
  applyStaticStyle,
  registerCustomTextures,
  resolveTexInfo,
} from './mapStyle.js'

/**
 * Engine + scene bootstrap and static world construction. WebGPU when the
 * browser supports it, WebGL otherwise — nothing else in the client cares
 * which one is active.
 */

export async function createEngine(canvas: HTMLCanvasElement): Promise<AbstractEngine> {
  if (await WebGPUEngine.IsSupportedAsync) {
    const engine = new WebGPUEngine(canvas, { antialias: true })
    await engine.initAsync()
    return engine
  }
  return new Engine(canvas, true)
}

export function createScene(engine: AbstractEngine): Scene {
  const scene = new Scene(engine)
  // Fallback sky color for engines without the atmosphere addon; the
  // Environment module owns all lights.
  scene.clearColor = new Color4(0.45, 0.62, 0.82, 1)
  return scene
}

// Per-scene material caches — multiple scenes (game, icon renderer,
// preview) must never share or overwrite each other's materials.
const materialCaches = new WeakMap<Scene, Map<string, StandardMaterial>>()

export function materialFor(scene: Scene, hex: string): StandardMaterial {
  let cache = materialCaches.get(scene)
  if (!cache) {
    cache = new Map()
    materialCaches.set(scene, cache)
  }
  let mat = cache.get(hex)
  if (!mat) {
    mat = new StandardMaterial(`mat:${hex}`, scene)
    mat.diffuseColor = Color3.FromHexString(hex)
    mat.specularColor = new Color3(0.08, 0.08, 0.08)
    mat.maxSimultaneousLights = 8
    cache.set(hex, mat)
  }
  return mat
}

export function meshForShape(scene: Scene, name: string, shape: WorldShape, color: string): Mesh {
  let mesh: Mesh
  switch (shape.type) {
    case 'box':
      mesh = CreateBox(
        name,
        { width: shape.size[0], height: shape.size[1], depth: shape.size[2] },
        scene,
      )
      break
    case 'cylinder':
      mesh = CreateCylinder(name, { diameter: shape.radius * 2, height: shape.height }, scene)
      break
    case 'sphere':
      mesh = CreateSphere(name, { diameter: shape.radius * 2 }, scene)
      break
  }
  mesh.material = materialFor(scene, color)
  mesh.rotationQuaternion = Quaternion.Identity()
  return mesh
}

/** Builds render meshes for the static level (mirrors the server's physics statics). */
/** Imported models from the edited map (textures live in mapStyle.ts). */
const mapModels = new Map<string, { glb: string; bounds: [number, number, number] }>()

export function registerMapAssets(
  map: {
    textures?: MapTextureEntry[]
    models?: { id: string; name: string; glb: string; bounds: [number, number, number] }[]
  } | null,
): void {
  registerCustomTextures(map?.textures)
  mapModels.clear()
  for (const m of map?.models ?? []) mapModels.set(m.id, { glb: m.glb, bounds: m.bounds })
}

/**
 * Imported-model static: the box shape stays the (invisible) physics
 * proxy; the glb renders in its place, centered on the proxy.
 */
/**
 * The game's model cache, so a model placed thirty times is parsed ONCE.
 *
 * This used to call `SceneLoader.ImportMeshAsync` per placement, which
 * re-parsed the same glTF for every copy — the editor already had a cache and
 * the runtime did not, so a map that opened instantly in the editor took
 * seconds to load in the game.
 */
let gameModelCache: ModelCache | null = null
const modelCacheFor = (scene: Scene): ModelCache => {
  if (!gameModelCache || gameModelCache.scene !== scene) gameModelCache = new ModelCache(scene)
  return gameModelCache
}

function attachModel(scene: Scene, proxy: Mesh, modelId: string, body?: StaticObjectV2): void {
  const model = mapModels.get(modelId)
  if (!model) return
  void modelCacheFor(scene)
    .instantiate(modelId, model.glb)
    .then((inst) => {
      if (!inst) return
      inst.root.parent = proxy
      proxy.visibility = 0
      for (const m of inst.root.getChildMeshes()) m.isPickable = false
      // Painted model slots get the same transparent overlay the editor
      // uses: the original glTF material stays visible wherever coverage is
      // zero, so an unpainted model looks exactly as its author exported it.
      const surfaces = (body?.surfaces ?? {}) as Record<string, SurfaceMaterialData>
      for (const [surfaceId, data] of Object.entries(surfaces)) {
        if (!surfaceId.startsWith('mesh:') || !data.paint?.layers.length) continue
        const path = /^mesh:([^/]+)\/material:\d+$/.exec(surfaceId)?.[1]
        const target = path ? childAtIndexPath(inst.root, path) : inst.root.getChildMeshes()[0]
        if (target)
          createModelPaintOverlay(scene, target, body!.id, surfaceId, data, (_o, _s, d) =>
            maskTextureFrom(scene, d.paint?.mask),
          )
      }
    })
    .catch(() => {
      // Model failed to load — the proxy box stays visible as a stand-in.
    })
}

/** Walk an index path to a child (matches the editor's surface ids). */
function childAtIndexPath(root: { getChildren?: () => unknown[] }, path: string): Mesh | null {
  let node: { getChildren?: () => unknown[] } | null = root
  for (const part of path.split('/')) {
    const children = (node?.getChildren?.() ?? []) as Mesh[]
    node = children[Number(part)] ?? null
    if (!node) return null
  }
  return node as unknown as Mesh
}

/** Extra terrain patches (mountains, cave shells) from the edited map. */
let legacyLayer = 0
export function buildTerrainPatches(
  scene: Scene,
  content: ContentRegistry,
  onlyIds?: readonly string[],
): Mesh[] {
  const meshes: Mesh[] = []
  const only = onlyIds ? new Set(onlyIds) : null
  for (const patch of getMapOverride()?.terrains ?? []) {
    if (only && !only.has(patch.id)) continue
    const grid = buildPatchGrid(patch.halfExtent, patch.sub, patch.heights)
    const mesh = new Mesh(`patch:${patch.id}`, scene)
    const vd = new VertexData()
    vd.positions = grid.positions
    vd.indices = grid.indices
    vd.uvs = grid.uvs
    const norms: number[] = []
    VertexData.ComputeNormals(grid.positions, grid.indices, norms)
    vd.normals = norms
    vd.applyToMesh(mesh, false)
    mesh.position.set(patch.origin[0], patch.origin[1], patch.origin[2])
    if (patch.rot) mesh.rotation.set(patch.rot[0], patch.rot[1], patch.rot[2])
    // Physics scales the trimesh vertices with scalePatchPositions(); Babylon
    // applies mesh scaling in the same S→R→T order, so the two agree.
    if (patch.scale) mesh.scaling.set(patch.scale[0], patch.scale[1], patch.scale[2])
    // v2 surfaces (base + paint layers) render with the SAME material class
    // the editor uses, so what was painted is what players see. Legacy `mix`
    // maps onto the same shader via migrateLegacyMix.
    const surface: SurfaceMaterialData | null = patch.surface
      ? patch.surface
      : patch.mix
        ? {
            base: {
              ...(patch.tex && patch.tex !== 'none' ? { tex: patch.tex } : {}),
              ...(patch.color ? { color: patch.color } : {}),
              ...(patch.uv ? { uv: patch.uv } : {}),
            },
            paint: migrateLegacyMix(patch.mix, () => `pl-${patch.id}-${legacyLayer++}`)!,
          }
        : null
    if (surface) {
      const layered = new LayeredSurfaceMaterial(scene, `psurf:${patch.id}`, surface, {
        baseTiling: Math.max(2, patch.halfExtent / 2),
        layerTiling: Math.max(2, patch.halfExtent / 2),
        backFaceCulling: false,
      })
      layered.setMaskTexture(maskTextureFrom(scene, surface.paint?.mask))
      layered.material.maxSimultaneousLights = 8
      mesh.material = layered.material
      mesh.receiveShadows = true
      meshes.push(mesh)
      continue
    }
    const mat = new StandardMaterial(`patchmat:${patch.id}`, scene)
    // 'none' = plain color (no texture at all); absent = default grass.
    const info = resolveTexInfo(patch.tex ?? 'leafy_grass')
    if (info) {
      const tx = new Texture(info.url, scene)
      applyPatchTexture(tx, patch.halfExtent, info, patch.uv)
      mat.diffuseTexture = tx
    }
    if (patch.color) mat.diffuseColor = Color3.FromHexString(patch.color)
    else if (!info) mat.diffuseColor = new Color3(0.75, 0.75, 0.75)
    mat.specularColor = new Color3(0.02, 0.02, 0.02)
    mat.maxSimultaneousLights = 8
    mesh.material = mat
    mesh.receiveShadows = true
    meshes.push(mesh)
  }
  void content
  return meshes
}

/**
 * Rebuild only the terrain meshes named in `ids` (all of them when omitted).
 *
 * Disposing and rebuilding every terrain because one was retinted re-uploads
 * the geometry of the whole map to the GPU; with stable ids only the ones
 * that changed need to move.
 */
export function rebuildTerrainPatchVisuals(
  scene: Scene,
  content: ContentRegistry,
  ids?: readonly string[],
): void {
  const wanted = ids ? new Set(ids.map((id) => `patch:${id}`)) : null
  for (const m of [...scene.meshes]) {
    if (!m.name.startsWith('patch:')) continue
    if (wanted && !wanted.has(m.name)) continue
    m.dispose(false, true)
  }
  buildTerrainPatches(scene, content, ids)
}

export function buildStaticWorld(scene: Scene, content: ContentRegistry): void {
  const world = content.world
  const water = new Water(scene)
  const groundMeshes = buildTerrainMesh(scene, content)
  for (const m of groundMeshes) water.addToRenderList(m)

  for (const [i, s] of world.statics.entries()) renderStaticBody(scene, water, s, `static:${i}`, i)
  buildMapStaticVisuals(scene, water)
}

/**
 * The MAP's statics, rendered under their stable ids in their own layer.
 * They used to be pushed into `content.world.statics` at boot, which merged
 * authored geometry into base content permanently — so a live save could add
 * a mesh but never move or remove one, and re-applying a map drew a second
 * copy on top of the first.
 */
export function buildMapStaticVisuals(
  scene: Scene,
  water?: Water,
  onlyIds?: readonly string[],
): void {
  const only = onlyIds ? new Set(onlyIds) : null
  for (const s of getMapOverride()?.statics ?? []) {
    if (only && !only.has(s.id ?? '')) continue
    renderStaticBody(scene, water, s, `mapstatic:${s.id ?? ''}`)
  }
}

/**
 * Live map save: rebuild only the map statics named in `ids` (all of them
 * when omitted), leaving base content alone.
 */
export function rebuildMapStaticVisuals(scene: Scene, ids?: readonly string[]): void {
  const wanted = ids ? new Set(ids.map((id) => `mapstatic:${id}`)) : null
  for (const m of [...scene.meshes]) {
    if (!m.name.startsWith('mapstatic:')) continue
    if (wanted && !wanted.has(m.name)) continue
    m.dispose(false, true)
  }
  buildMapStaticVisuals(scene, undefined, ids)
}

function renderStaticBody(
  scene: Scene,
  water: Water | undefined,
  s: StaticBody,
  name: string,
  decorSeed?: number,
): void {
  const mesh = meshForShape(scene, name, effectiveShape(s), s.color)
  applyStaticStyle(scene, mesh, s)
  // v2 painted surfaces render through the SAME module the editor uses, so
  // what an author painted is what players see. Legacy statics with no
  // surface data are untouched by this.
  applyPaintedStatic(scene, mesh, s as StaticObjectV2, (_owner, _surface, data) =>
    maskTextureFrom(scene, data.paint?.mask),
  )
  if (s.model) attachModel(scene, mesh, s.model, s as StaticObjectV2)
  mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
  mesh.rotationQuaternion = s.rot
    ? Quaternion.FromEulerAngles(s.rot[0], s.rot[1], s.rot[2])
    : Quaternion.FromEulerAngles(0, s.yaw, 0)
  water?.addToRenderList(mesh)
  if (s.decor === 'building') decorateBuilding(scene, mesh, s)
  else if (s.decor === 'fountain' && water) buildFountain(scene, mesh, s, water)
  else if (s.decor === 'lamp') decorateLamp(scene, mesh, s, decorSeed ?? 0)
}

/**
 * City buildings get a clay-tiled pyramid roof, doors and warm-lit windows
 * (client dressing only — the server's collision box is the plain shell).
 */
function decorateBuilding(scene: Scene, building: Mesh, s: StaticBody): void {
  if (s.shape.type !== 'box') return
  const [w, h, d] = s.shape.size
  const roof = CreateCylinder(
    `${building.name}:roof`,
    { diameterTop: 0.02, diameterBottom: Math.SQRT2, height: 1, tessellation: 4 },
    scene,
  )
  roof.parent = building
  roof.rotation.y = Math.PI / 4
  roof.scaling.set(w + 0.8, 1.5, d + 0.8)
  roof.position.y = h / 2 + 0.75
  const roofMat = new StandardMaterial(`${building.name}:roofmat`, scene)
  const roofTex = new Texture('/assets/tex/clay_roof_tiles.jpg', scene)
  roofTex.uScale = 3
  roofTex.vScale = 2
  roofMat.diffuseTexture = roofTex
  roofMat.specularColor = new Color3(0.03, 0.03, 0.03)
  roof.material = roofMat

  const doorMat = new StandardMaterial(`${building.name}:door`, scene)
  doorMat.diffuseColor = Color3.FromHexString('#3a2a1c')
  doorMat.specularColor = Color3.Black()
  const winMat = new StandardMaterial(`${building.name}:win`, scene)
  winMat.diffuseColor = Color3.FromHexString('#2a3540')
  winMat.emissiveColor = new Color3(0.45, 0.34, 0.14) // warm glow at night
  winMat.specularColor = Color3.Black()

  for (const side of [1, -1]) {
    const door = CreateBox(
      `${building.name}:door${side}`,
      { width: 1, height: 1.9, depth: 0.1 },
      scene,
    )
    door.parent = building
    door.position.set(0, -h / 2 + 0.95, side * (d / 2 + 0.03))
    door.material = doorMat
    for (const wx of [-1, 1]) {
      const win = CreateBox(
        `${building.name}:win${side}${wx}`,
        { width: 0.8, height: 0.8, depth: 0.08 },
        scene,
      )
      win.parent = building
      win.position.set((wx * w) / 3.4, 0.45, side * (d / 2 + 0.03))
      win.material = winMat
    }
  }
}

/**
 * Street lamp: arm + warm head on the post; its PointLight is named
 * 'lamp:*' so the Environment fades it up after dark.
 */
function decorateLamp(scene: Scene, post: Mesh, s: StaticBody, i: number): void {
  const head = CreateBox(`${post.name}:head`, { width: 0.34, height: 0.22, depth: 0.34 }, scene)
  head.parent = post
  head.position.y = 1.75
  const headMat = new StandardMaterial(`${post.name}:headmat`, scene)
  headMat.diffuseColor = Color3.FromHexString('#2c3136')
  headMat.emissiveColor = new Color3(0.45, 0.36, 0.16)
  head.material = headMat
  const light = new PointLight(`lamp:${i}`, new Vector3(s.pos[0], s.pos[1] + 1.9, s.pos[2]), scene)
  light.diffuse = new Color3(1, 0.82, 0.5)
  light.intensity = 0 // Environment drives this after dark
  light.range = 16
}

/**
 * The plaza centerpiece: a real fountain — basin with live water, column,
 * upper bowl and a particle spray — replacing the bare cylinder look.
 */
function buildFountain(scene: Scene, base: Mesh, s: StaticBody, water: Water): void {
  const [cx, , cz] = s.pos
  const baseY = s.pos[1] - (s.shape.type === 'cylinder' ? s.shape.height / 2 : 0.45)
  const mk = (name: string, opts: Parameters<typeof CreateCylinder>[1], y: number, hex: string) => {
    const m = CreateCylinder(`fountain:${name}`, opts, scene)
    m.position.set(cx, baseY + y, cz)
    m.material = materialFor(scene, hex)
    water.addToRenderList(m)
    return m
  }
  // Dress the collision cylinder as the basin wall; add rim, column, bowl.
  base.material = materialFor(scene, '#8f8a82')
  mk('rim', { diameter: 3.6, height: 0.18, tessellation: 28 }, 0.95, '#a8a29a')
  mk('column', { diameter: 0.5, height: 1.5, tessellation: 16 }, 1.6, '#8f8a82')
  mk(
    'bowl',
    { diameterTop: 1.7, diameterBottom: 0.9, height: 0.35, tessellation: 24 },
    2.35,
    '#a8a29a',
  )

  // Water surface inside the basin: its own CALM water material — the
  // ocean's wave vertex displacement turns a small low-poly disc into
  // spiky shards, so the pool animates via bump only.
  const pool = CreateCylinder(
    'fountain:pool',
    { diameter: 3.1, height: 0.02, tessellation: 28 },
    scene,
  )
  pool.position.set(cx, baseY + 0.84, cz)
  pool.material = water.makeCalmSurface('fountain-pool')
  pool.isPickable = false

  // Spray: a slim upward jet that arcs back into the bowl.
  const spray = new ParticleSystem('fountain:spray', 220, scene)
  spray.particleTexture = new Texture(dropletTexture(), scene)
  spray.emitter = new Vector3(cx, baseY + 2.55, cz)
  spray.minEmitBox = new Vector3(-0.05, 0, -0.05)
  spray.maxEmitBox = new Vector3(0.05, 0, 0.05)
  spray.direction1 = new Vector3(-0.35, 2.6, -0.35)
  spray.direction2 = new Vector3(0.35, 3.2, 0.35)
  spray.gravity = new Vector3(0, -9.8, 0)
  spray.minSize = 0.05
  spray.maxSize = 0.12
  spray.minLifeTime = 0.7
  spray.maxLifeTime = 1.1
  spray.emitRate = 120
  spray.color1 = new BColor4(0.75, 0.87, 0.95, 0.85)
  spray.color2 = new BColor4(0.55, 0.75, 0.9, 0.7)
  spray.colorDead = new BColor4(0.6, 0.8, 0.95, 0)
  spray.start()
}

/** Tiny soft droplet sprite (no asset needed). */
function dropletTexture(): string {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  return canvas.toDataURL()
}

/** Live map edit: replace the rendered terrain with the new grid + paint. */
export function rebuildTerrainVisual(scene: Scene, content: ContentRegistry): void {
  scene.getMeshByName('terrain')?.dispose(false, true)
  scene.getMeshByName('terrain-skirt')?.dispose(false, true)
  const meshes = buildTerrainMesh(scene, content)
  // Water reflections keep working on the fresh meshes.
  const waterMat = scene.getMeshByName('water')?.material as
    { addToRenderList?: (m: unknown) => void } | undefined
  for (const m of meshes) waterMat?.addToRenderList?.(m)
}

/**
 * The BASE WORLD's procedural terrain — content, not authored map data.
 *
 * When a map is loaded it supplies every terrain object itself, so this grid
 * is not built at all. It used to be built regardless, resampling the map's
 * own terrains onto a world-sized grid: a second copy of the ground on top of
 * the per-terrain meshes, and — for a map with no terrain at all — a flat
 * sheet at y = 0 that looked like nothing and collided like a floor. That is
 * the invisible ground a blank map is not allowed to have.
 */
function buildTerrainMesh(scene: Scene, content: ContentRegistry): Mesh[] {
  if (getMapOverride()) return []
  const world = content.world
  const grid = buildTerrainGrid(world)
  const mesh = new Mesh('terrain', scene)
  const vd = new VertexData()
  vd.positions = grid.positions
  vd.indices = grid.indices
  vd.uvs = grid.uvs
  const normals: number[] = []
  VertexData.ComputeNormals(grid.positions, grid.indices, normals)
  vd.normals = normals
  vd.applyToMesh(mesh)
  mesh.isPickable = false
  mesh.receiveShadows = true

  // The same layered-surface shader the editor and every authored terrain
  // use: grass base with rock and mud painted over it by the procedural mix.
  // (This was TerrainMaterial, whose three diffuse slots were hard-wired to
  // exactly those textures and which had no notion of a base at all.)
  const layered = new LayeredSurfaceMaterial(
    scene,
    'terrain',
    {
      base: { tex: 'leafy_grass' },
      paint: {
        layers: [
          { id: 'world-grass', tex: 'leafy_grass', channel: 'r', scale: 70 },
          { id: 'world-rock', tex: 'gray_rocks', channel: 'g', scale: 55 },
          { id: 'world-mud', tex: 'brown_mud_dry', channel: 'b', scale: 60 },
        ],
      },
    },
    { baseTiling: 70 },
  )
  layered.setMaskTexture(paintMixMap(scene, world.groundHalfExtent))
  layered.material.maxSimultaneousLights = 8
  mesh.material = layered.material

  // Horizon skirt: a huge tinted disc under the world edge so the map
  // border melts into distant fields instead of a hard void band.
  const skirt = CreateCylinder(
    'terrain-skirt',
    { diameter: 4000, height: 0.2, tessellation: 48 },
    scene,
  )
  skirt.position.y = -3.2
  const skirtMat = new StandardMaterial('terrain-skirt', scene)
  // Seabed: it now lies under the ocean sheet, not at the horizon.
  skirtMat.diffuseColor = new Color3(0.22, 0.24, 0.19)
  skirtMat.specularColor = Color3.Black()
  skirt.material = skirtMat
  skirt.isPickable = false
  return [mesh, skirt]
}

/** World-region painter for the splat mix map (R grass, G rock, B mud). */
function paintMixMap(scene: Scene, halfExtent: number): DynamicTexture {
  const size = 512
  const dt = new DynamicTexture('terrain-mix', size, scene, false)
  const ctx = dt.getContext() as CanvasRenderingContext2D
  const px = (wx: number) => ((wx + halfExtent) / (halfExtent * 2)) * size
  const py = (wz: number) => (1 - (wz + halfExtent) / (halfExtent * 2)) * size
  const blob = (wx: number, wz: number, r: number, style: string) => {
    const g = ctx.createRadialGradient(
      px(wx),
      py(wz),
      0,
      px(wx),
      py(wz),
      (r / (halfExtent * 2)) * size,
    )
    g.addColorStop(0, style)
    g.addColorStop(0.75, style)
    g.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, size, size)
  }
  // Base: pure grass.
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, size, size)
  // Quarry (SW): rock.
  blob(-42, -42, 26, 'rgba(0,255,0,0.95)')
  blob(-30, -30, 10, 'rgba(0,255,0,0.7)')
  // Scrapyard (SE): mud.
  blob(41, -42, 24, 'rgba(0,0,255,0.95)')
  // Inside the city walls: packed dirt (the plaza slab covers the center).
  ctx.fillStyle = 'rgba(0,0,255,0.85)'
  ctx.fillRect(px(-20), py(20), px(20) - px(-20), py(-20) - py(20))
  // Trails from each gate out into the wilds.
  ctx.strokeStyle = 'rgba(0,0,255,0.75)'
  ctx.lineWidth = ((4 / (halfExtent * 2)) * size) | 0
  ctx.lineCap = 'round'
  const trail = (x1: number, z1: number, x2: number, z2: number) => {
    ctx.beginPath()
    ctx.moveTo(px(x1), py(z1))
    ctx.lineTo(px(x2), py(z2))
    ctx.stroke()
  }
  trail(0, 20, 0, 30)
  trail(0, 30, 34, 40) // north gate -> forest
  trail(0, -20, 0, -26)
  trail(20, 0, 30, 0)
  trail(30, 0, 40, -34) // east gate -> scrapyard
  trail(-20, 0, -28, 0)
  trail(-28, 0, -38, -36) // west gate -> quarry
  dt.update()
  return dt
}
