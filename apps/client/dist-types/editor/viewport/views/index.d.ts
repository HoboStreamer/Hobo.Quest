import { Quaternion } from '@babylonjs/core/Maths/math.vector.js'
import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js'
import type { Scene } from '@babylonjs/core/scene.js'
import {
  type ContentRegistry,
  type MapLightV2,
  type SurfaceMaterialData,
  type TerrainObjectV2,
} from '@hobo/content'
import { LayeredSurfaceMaterial } from '../../../render/layeredSurface.js'
import type { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js'
import type { ModelCache } from '../../../render/modelCache.js'
import type { EditorObject, EditorObjectKind } from '../../document/editorDocument.js'
import type { EditorView } from '../editorViewRegistry.js'
/** Everything a view needs that is not the object itself. */
export interface ViewContext {
  scene: Scene
  /**
   * The live mask for a surface, created on demand. Views ask for one
   * rather than owning it: a box has six independently paintable faces and
   * a model has one per slot, so a mask belongs to a SURFACE.
   */
  maskFor: (ownerId: string, surfaceId: string, data: SurfaceMaterialData) => DynamicTexture
  content: ContentRegistry
  modelCache: ModelCache
  /** Shared wireframe material for terrain sculpt overlays. */
  wireMat: StandardMaterial
  /** Highest authored terrain at (x, z); 0 where none covers it. */
  sampleGround: (x: number, z: number) => number
  /** glb source for an imported model id, or null. */
  modelSource: (id: string) => string | null
  /** Ask for a rebuild after async work changed the mesh set. */
  reindex: (id: string) => void
  newId: (prefix: string) => string
}
export declare const lightQuat: (l: MapLightV2) => Quaternion
/**
 * A terrain's heights live in the document as base64 and in the view as a
 * decoded `Float32Array`. The decoded copy is WORKING STATE for sculpting —
 * decoding 260 000 floats per brush dab is not viable — and the view is the
 * only thing that holds it. `flushHeights()` is the one path back to the
 * document, so the two cannot silently disagree.
 */
export declare class TerrainView implements EditorView {
  readonly id: string
  private readonly ctx
  readonly kind: 'terrain'
  readonly root: Mesh
  readonly wire: Mesh
  heights: Float32Array
  sub: number
  halfExtent: number
  surface: LayeredSurfaceMaterial
  private maskTexture
  private terrain
  constructor(id: string, terrain: TerrainObjectV2, ctx: ViewContext)
  /** The document surface, defaulted so a plain terrain still paints. */
  surfaceData(): SurfaceMaterialData
  private applyPose
  /** Push the working heightfield into the mesh (and its wire overlay). */
  refreshHeights(): void
  /** The encoded heights, for writing back to the document. */
  encodedHeights(): string
  /** Re-read the material after a base/layer change. */
  refreshSurface(data: SurfaceMaterialData): void
  setWireVisible(on: boolean): void
  wireVisible(): boolean
  meshes(): Mesh[]
  update(object: EditorObject, keys: readonly string[]): boolean
  setVisible(on: boolean): void
  dispose(): void
}
/** The factory the registry uses. */
export declare function createViewFactory(
  ctx: ViewContext,
): (id: string, kind: EditorObjectKind, object: EditorObject) => EditorView
//# sourceMappingURL=index.d.ts.map
