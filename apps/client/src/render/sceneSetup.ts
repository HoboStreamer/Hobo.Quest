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
import { buildTerrainGrid, type ContentRegistry, type WorldShape } from '@hobo/content'

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
export function buildStaticWorld(scene: Scene, content: ContentRegistry): void {
  const world = content.world
  buildTerrainMesh(scene, content)

  for (const [i, s] of world.statics.entries()) {
    const mesh = meshForShape(scene, `static:${i}`, s.shape, s.color)
    if (s.tex) applyStaticTexture(scene, mesh, s)
    mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
    mesh.rotationQuaternion = s.rot
      ? Quaternion.FromEulerAngles(s.rot[0], s.rot[1], s.rot[2])
      : Quaternion.FromEulerAngles(0, s.yaw, 0)
  }
}

/**
 * Terrain: the SHARED heightfield grid (same one physics collides with)
 * rendered with 3-way texture splatting — grass everywhere, rock in the
 * quarry + trails, mud in the scrapyard and inside the city walls. The mix
 * map is painted procedurally from world-space regions.
 */
function buildTerrainMesh(scene: Scene, content: ContentRegistry): void {
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
  mat.mixTexture = paintMixMap(scene, world.groundHalfExtent)
  mat.diffuseTexture1 = tiled(scene, 'leafy_grass', 70) // R
  mat.diffuseTexture2 = tiled(scene, 'gray_rocks', 55) // G
  mat.diffuseTexture3 = tiled(scene, 'brown_mud_dry', 60) // B
  mat.specularColor = new Color3(0.02, 0.02, 0.02)
  mesh.material = mat

  // Horizon skirt: a huge tinted disc under the world edge so the map
  // border melts into distant fields instead of a hard void band.
  const skirt = CreateCylinder(
    'terrain-skirt',
    { diameter: 4000, height: 0.2, tessellation: 48 },
    scene,
  )
  skirt.position.y = -0.6
  const skirtMat = new StandardMaterial('terrain-skirt', scene)
  skirtMat.diffuseColor = new Color3(0.33, 0.4, 0.26)
  skirtMat.specularColor = Color3.Black()
  skirt.material = skirtMat
  skirt.isPickable = false
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
  mesh.material = mat
}
