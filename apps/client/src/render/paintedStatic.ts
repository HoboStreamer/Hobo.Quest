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
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { StaticObjectV2, SurfaceMaterialData } from '@hobo/content'
import { LayeredSurfaceMaterial } from './layeredSurface.js'

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
): { mesh: Mesh; dispose: () => void } | null {
  const clone = (source as Mesh).clone(`paintovl:${ownerId}:${surfaceId}`, source.parent, true)
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

  // Without UVs there is nothing for the mask to be sampled against; the
  // caller's box projection writes into a generated channel instead.
  if (!clone.isVerticesDataPresent(VertexBuffer.UVKind)) {
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
