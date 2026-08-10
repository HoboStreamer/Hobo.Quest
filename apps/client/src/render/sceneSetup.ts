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
import { TerrainMaterial } from '@babylonjs/materials/terrain/terrainMaterial.js'
import { ParticleSystem } from '@babylonjs/core/Particles/particleSystem.js'
import { PointLight } from '@babylonjs/core/Lights/pointLight.js'
import { Color4 as BColor4 } from '@babylonjs/core/Maths/math.color.js'
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import {
  buildTerrainGrid,
  type ContentRegistry,
  type WorldShape,
  type StaticBody,
} from '@hobo/content'
import { Water } from './water.js'

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
export function buildStaticWorld(scene: Scene, content: ContentRegistry, mapMix?: string): void {
  const world = content.world
  const water = new Water(scene)
  const groundMeshes = buildTerrainMesh(scene, content, mapMix)
  for (const m of groundMeshes) water.addToRenderList(m)

  for (const [i, s] of world.statics.entries()) {
    const mesh = meshForShape(scene, `static:${i}`, s.shape, s.color)
    if (s.tex) applyStaticTexture(scene, mesh, s)
    mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
    mesh.rotationQuaternion = s.rot
      ? Quaternion.FromEulerAngles(s.rot[0], s.rot[1], s.rot[2])
      : Quaternion.FromEulerAngles(0, s.yaw, 0)
    water.addToRenderList(mesh)
    if (s.decor === 'building') decorateBuilding(scene, mesh, s)
    else if (s.decor === 'fountain') buildFountain(scene, mesh, s, water)
    else if (s.decor === 'lamp') decorateLamp(scene, mesh, s, i)
  }
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

/**
 * Terrain: the SHARED heightfield grid (same one physics collides with)
 * rendered with 3-way texture splatting — grass everywhere, rock in the
 * quarry + trails, mud in the scrapyard and inside the city walls. The mix
 * map is painted procedurally from world-space regions.
 */
function buildTerrainMesh(scene: Scene, content: ContentRegistry, mapMix?: string): Mesh[] {
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

  const mat = new TerrainMaterial('terrain', scene)
  // Hand-painted splat from the map editor wins over the procedural paint.
  mat.mixTexture = mapMix ? new Texture(mapMix, scene) : paintMixMap(scene, world.groundHalfExtent)
  mat.diffuseTexture1 = tiled(scene, 'leafy_grass', 70) // R
  mat.diffuseTexture2 = tiled(scene, 'gray_rocks', 55) // G
  mat.diffuseTexture3 = tiled(scene, 'brown_mud_dry', 60) // B
  mat.specularColor = new Color3(0.02, 0.02, 0.02)
  mat.maxSimultaneousLights = 8
  mesh.material = mat

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

function tiled(scene: Scene, name: string, scale: number): Texture {
  const tex = new Texture(`/assets/tex/${name}.jpg`, scene)
  tex.uScale = scale
  tex.vScale = scale
  return tex
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

function applyStaticTexture(
  scene: Scene,
  mesh: Mesh,
  s: { shape: WorldShape; color: string; tex?: string | undefined },
): void {
  if (!s.tex) return
  const mat = new StandardMaterial(`static-tex:${mesh.name}`, scene)
  const tex = new Texture(`/assets/tex/${s.tex}.jpg`, scene)
  // Tile roughly every 2m using the mesh's dominant dimensions.
  const dims =
    s.shape.type === 'box'
      ? s.shape.size
      : s.shape.type === 'cylinder'
        ? [s.shape.radius * 2, s.shape.height, s.shape.radius * 2]
        : [s.shape.radius * 2, s.shape.radius * 2, s.shape.radius * 2]
  tex.uScale = Math.max(1, Math.round(Math.max(dims[0] ?? 1, dims[2] ?? 1) / 2))
  tex.vScale = Math.max(1, Math.round((dims[1] ?? 1) / 2))
  mat.diffuseTexture = tex
  // Mostly let the texture speak — a heavy tint multiplies photos into mud.
  mat.diffuseColor = Color3.Lerp(Color3.FromHexString(s.color), Color3.White(), 0.75)
  mat.specularColor = new Color3(0.04, 0.04, 0.04)
  mat.maxSimultaneousLights = 8
  mesh.material = mat
}
