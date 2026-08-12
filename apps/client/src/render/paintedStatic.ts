/**
 * Rendering a painted static — the SAME interpretation in the editor and in
 * the game, so what an author paints is what players see.
 *
 * Three cases, because three shapes need different treatment:
 *
 *  - A BOX with per-face surfaces gets a MultiMaterial: one layered material
 *    per painted face, the ordinary style on the rest. Painting one wall must
 *    not restyle the other five.
 *  - A CYLINDER or SPHERE has one surface, so its material is simply the
 *    layered one.
 *  - An IMPORTED MODEL keeps its original glTF material and gets a transparent
 *    paint OVERLAY. Replacing a PBR material with a layered one would mean
 *    "painting a model" turned it grey everywhere the brush had not been,
 *    which is not painting, it is retexturing. The invariant is: where mask
 *    coverage is 0, the original asset shows through unchanged.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color.js'
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial.js'
import { SubMesh } from '@babylonjs/core/Meshes/subMesh.js'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer.js'
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { StaticObjectV2, SurfaceMaterialData } from '@hobo/content'
import { LayeredSurfaceMaterial } from './layeredSurface.js'
import { faceIndexFromNormal, faceUV, hasUsableUV0 } from './surfaceProjection.js'

/** Resolves the live (or loaded) mask texture for one surface. */
export type MaskResolver = (
  ownerId: string,
  surfaceId: string,
  data: SurfaceMaterialData,
) => Texture | null

export interface PaintedStaticResult {
  /** Materials created here, so the caller can dispose them. */
  dispose: () => void
}

/** Babylon's box face order, matching `faceIndexFromNormal`. */
const BOX_FACES = 6
/** Vertices/indices per box face in Babylon's box geometry. */
const INDICES_PER_FACE = 6

const surfacesOf = (body: StaticObjectV2): Record<string, SurfaceMaterialData> =>
  (body.surfaces ?? {}) as Record<string, SurfaceMaterialData>

/** Does this static have any authored v2 surface at all? */
export function hasPaintedSurface(body: StaticObjectV2): boolean {
  if (body.surface?.paint?.layers.length) return true
  return Object.values(surfacesOf(body)).some((s) => s.paint?.layers.length)
}

/**
 * Apply painted surfaces to a static's mesh. Returns null when the static has
 * no v2 surface data, in which case the caller's ordinary styling stands.
 */
export function applyPaintedStatic(
  scene: Scene,
  mesh: Mesh,
  body: StaticObjectV2,
  maskFor: MaskResolver,
): PaintedStaticResult | null {
  if (!hasPaintedSurface(body)) return null
  const created: { dispose: () => void }[] = []
  const surfaces = surfacesOf(body)

  const layered = (
    surfaceId: string,
    data: SurfaceMaterialData,
    tiling: number,
  ): LayeredSurfaceMaterial => {
    const material = new LayeredSurfaceMaterial(scene, `paint:${body.id}:${surfaceId}`, data, {
      baseTiling: tiling,
      layerTiling: tiling,
    })
    material.setMaskTexture(maskFor(body.id, surfaceId, data))
    material.material.maxSimultaneousLights = 8
    created.push({ dispose: () => material.material.dispose() })
    return material
  }

  const faceIds = Object.keys(surfaces).filter((k) => k.startsWith('face:'))
  if (body.shape.type === 'box' && faceIds.length > 0) {
    // Per-face: split the box into six submeshes and give each its own
    // material, so a painted face and a plain one coexist.
    const multi = new MultiMaterial(`paintmulti:${body.id}`, scene)
    created.push({ dispose: () => multi.dispose() })
    const plain = mesh.material
    for (let face = 0; face < BOX_FACES; face++) {
      const data = surfaces[`face:${face}`]
      multi.subMaterials.push(data ? layered(`face:${face}`, data, 1).material : plain)
    }
    mesh.subMeshes = []
    const verticesCount = mesh.getTotalVertices()
    for (let face = 0; face < BOX_FACES; face++)
      new SubMesh(face, 0, verticesCount, face * INDICES_PER_FACE, INDICES_PER_FACE, mesh)
    mesh.material = multi
    return { dispose: () => created.forEach((c) => c.dispose()) }
  }

  const whole = body.surface as SurfaceMaterialData | undefined
  if (whole?.paint?.layers.length) {
    mesh.material = layered('surface', whole, 1).material
    return { dispose: () => created.forEach((c) => c.dispose()) }
  }
  return created.length > 0 ? { dispose: () => created.forEach((c) => c.dispose()) } : null
}

/**
 * A transparent paint overlay for one child mesh of an imported model.
 *
 * The overlay is a geometry clone sitting a hair proud of the original, with
 * a layered material whose alpha IS the mask coverage. The original glTF
 * material underneath is untouched, so an unpainted model looks exactly as
 * its author exported it — and painting one instance cannot affect another,
 * because the overlay belongs to the instance rather than to the cached
 * template.
 */
export function createModelPaintOverlay(
  scene: Scene,
  source: AbstractMesh,
  ownerId: string,
  surfaceId: string,
  data: SurfaceMaterialData,
  maskFor: MaskResolver,
  /**
   * How to project a mesh that shipped with no usable UVs. Must be the space
   * the BRUSH used, or the paint would be shown somewhere other than where it
   * was applied.
   */
  fallback?: { root: TransformNode; extent: readonly [number, number, number] },
): { mesh: Mesh; dispose: () => void } | null {
  const clone = cloneForOverlay(source, `paintovl:${ownerId}:${surfaceId}`)
  if (!clone) return null
  clone.isPickable = false
  // A hair proud, so it never z-fights the surface it decorates.
  clone.scaling = clone.scaling.scale(1.001)

  const material = new LayeredSurfaceMaterial(scene, `paintovlmat:${ownerId}:${surfaceId}`, data, {
    baseTiling: 1,
    layerTiling: 1,
  })
  material.setMaskTexture(maskFor(ownerId, surfaceId, data))
  // Alpha comes from the mask: zero coverage is fully transparent, which is
  // what leaves the original material visible.
  material.material.useAlphaFromDiffuseTexture = false
  material.material.alpha = 0.999
  material.material.needAlphaBlending = () => true
  material.material.diffuseColor = Color3.White()
  material.material.maxSimultaneousLights = 8
  clone.material = material.material

  // Without usable UVs there is nothing for the mask to be sampled against.
  // The brush falls back to a box projection rather than doing nothing, so
  // the overlay bakes THAT SAME projection into the clone — otherwise a
  // stroke would be recorded and then displayed nowhere.
  if (!hasUsableUV0(clone) && !bakeBoxProjectedUVs(clone, fallback)) {
    clone.dispose()
    material.material.dispose()
    return null
  }

  return {
    mesh: clone,
    dispose: () => {
      material.material.dispose()
      clone.dispose()
    },
  }
}

/**
 * An INDEPENDENT mesh to hang the overlay material on.
 *
 * `ModelCache` instantiates models as `InstancedMesh`es, which share their
 * source's material: assigning one a material either does nothing or repaints
 * the template and with it every other placement of that model. So an
 * instance is cloned from its SOURCE mesh and given the instance's own local
 * transform, producing a real `Mesh` that can carry its own material.
 *
 * Geometry stays shared — that is not mutation, and it is what makes the
 * overlay cheap. `bakeBoxProjectedUVs` is the one path that writes vertex
 * data, and it detaches the geometry first.
 */
function cloneForOverlay(source: AbstractMesh, name: string): Mesh | null {
  const instanced = source as AbstractMesh & { sourceMesh?: Mesh }
  const template = instanced.sourceMesh ?? (source as Mesh)
  const clone = template.clone(name, source.parent, true)
  if (!clone) return null
  if (instanced.sourceMesh) {
    // The instance's pose, not the template's.
    clone.position.copyFrom(source.position)
    clone.scaling.copyFrom(source.scaling)
    if (source.rotationQuaternion) clone.rotationQuaternion = source.rotationQuaternion.clone()
    else {
      clone.rotationQuaternion = null
      clone.rotation.copyFrom(source.rotation)
    }
  }
  return clone
}

/**
 * Write box-projected UVs onto an overlay clone, in the owning static's local
 * space — the space `PaintController` projects into when a model has no UV0.
 *
 * Per-vertex rather than per-face, so a mesh whose triangles span more than
 * one dominant axis still gets continuous coverage on each of them. Returns
 * false when there is nothing to project from, and the caller drops the
 * overlay rather than showing paint in the wrong place.
 */
function bakeBoxProjectedUVs(
  clone: Mesh,
  fallback?: { root: TransformNode; extent: readonly [number, number, number] },
): boolean {
  if (!fallback) return false
  const positions = clone.getVerticesData(VertexBuffer.PositionKind)
  if (!positions || positions.length < 9) return false
  // The clone shares the cached template's geometry. Writing UVs into that
  // would alter the template and every other placement of the model, so the
  // geometry is detached first — the cached AssetContainer is never touched.
  clone.makeGeometryUnique()
  const normals = clone.getVerticesData(VertexBuffer.NormalKind)
  const toRoot = clone
    .computeWorldMatrix(true)
    .multiply(Matrix.Invert(fallback.root.computeWorldMatrix(true)))
  const extent: [number, number, number] = [
    Math.max(1e-6, fallback.extent[0]),
    Math.max(1e-6, fallback.extent[1]),
    Math.max(1e-6, fallback.extent[2]),
  ]

  const uvs = new Float32Array((positions.length / 3) * 2)
  const p = new Vector3()
  const n = new Vector3()
  for (let i = 0, j = 0; i + 2 < positions.length; i += 3, j += 2) {
    p.set(positions[i]!, positions[i + 1]!, positions[i + 2]!)
    Vector3.TransformCoordinatesToRef(p, toRoot, p)
    if (normals && i + 2 < normals.length) {
      n.set(normals[i]!, normals[i + 1]!, normals[i + 2]!)
      Vector3.TransformNormalToRef(n, toRoot, n)
    } else {
      // No normals: the direction from the model's centre is the best
      // available guess at which face a vertex belongs to.
      n.copyFrom(p)
    }
    const uv = faceUV(p, extent, faceIndexFromNormal(n))
    uvs[j] = uv.u
    uvs[j + 1] = uv.v
  }
  clone.setVerticesData(VertexBuffer.UVKind, uvs)
  return true
}
