import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
import type { Texture } from '@babylonjs/core/Materials/Textures/texture.js'
import type { StaticObjectV2, SurfaceMaterialData } from '@hobo/content'
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
/** Does this static have any authored v2 surface at all? */
export declare function hasPaintedSurface(body: StaticObjectV2): boolean
/**
 * Apply painted surfaces to a static's mesh. Returns null when the static has
 * no v2 surface data, in which case the caller's ordinary styling stands.
 */
export declare function applyPaintedStatic(
  scene: Scene,
  mesh: Mesh,
  body: StaticObjectV2,
  maskFor: MaskResolver,
): PaintedStaticResult | null
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
export declare function createModelPaintOverlay(
  scene: Scene,
  source: AbstractMesh,
  ownerId: string,
  surfaceId: string,
  data: SurfaceMaterialData,
  maskFor: MaskResolver,
): {
  mesh: Mesh
  dispose: () => void
} | null
//# sourceMappingURL=paintedStatic.d.ts.map
