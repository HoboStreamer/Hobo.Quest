import { Engine } from '@babylonjs/core/Engines/engine.js'
import { WebGPUEngine } from '@babylonjs/core/Engines/webgpuEngine.js'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight.js'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color.js'
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder.js'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder.js'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder.js'
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { Scene } from '@babylonjs/core/scene.js'
import type { ContentRegistry, WorldShape } from '@hobo/content'

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
  scene.clearColor = new Color4(0.45, 0.62, 0.82, 1)

  const hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, 0.1), scene)
  hemi.intensity = 0.75
  hemi.groundColor = new Color3(0.25, 0.22, 0.2)
  const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, -0.3), scene)
  sun.intensity = 0.6
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
  const ground = CreateGround(
    'ground',
    { width: world.groundHalfExtent * 2, height: world.groundHalfExtent * 2 },
    scene,
  )
  const groundMat = new StandardMaterial('ground', scene)
  groundMat.diffuseColor = new Color3(0.35, 0.42, 0.3)
  groundMat.specularColor = Color3.Black()
  ground.material = groundMat

  for (const [i, s] of world.statics.entries()) {
    const mesh = meshForShape(scene, `static:${i}`, s.shape, s.color)
    mesh.position.set(s.pos[0], s.pos[1], s.pos[2])
    mesh.rotationQuaternion = Quaternion.FromEulerAngles(0, s.yaw, 0)
  }
}
