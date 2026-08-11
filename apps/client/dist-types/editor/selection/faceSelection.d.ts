import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Scene } from '@babylonjs/core/scene.js'
/**
 * Which surface of an object is selected. `face` is a box face index 0..5;
 * `null` means the whole surface (cylinders, spheres, terrain), where finer
 * sub-surface semantics do not exist yet.
 */
export interface FaceRef {
  objectId: string
  face: number | null
}
export declare const faceKey: (r: FaceRef) => string
export declare const parseFaceKey: (key: string) => FaceRef
/** Babylon's box face order, matching `Math.floor(pickInfo.faceId / 2)`. */
export declare const FACE_NAMES: readonly ['Front', 'Back', 'Right', 'Left', 'Top', 'Bottom']
export declare const faceLabel: (r: FaceRef) => string
/**
 * Ordered set of selected faces. Insertion order fixes which one is primary,
 * so the Face panel's "lift" always reads from a predictable surface.
 */
export declare class FaceSelection {
  private _keys
  get size(): number
  keys(): string[]
  refs(): FaceRef[]
  primary(): FaceRef | null
  has(r: FaceRef): boolean
  replace(r: FaceRef): void
  /** Ctrl-click: add, or toggle off when the face is already selected. */
  toggle(r: FaceRef): void
  clear(): void
  /** Drop faces whose object no longer exists (after undo / remote merge). */
  retain(exists: (objectId: string) => boolean): void
  describe(): string
}
/**
 * Draws one translucent overlay per selected face, built from that face's own
 * triangles. Overlays are editor-only: not pickable, and rendered in a later
 * rendering group with a negative z-offset so they sit on the surface without
 * z-fighting.
 */
export declare class FaceOverlayManager {
  private readonly scene
  private overlays
  private readonly matPrimary
  private readonly matSecondary
  private readonly matHover
  constructor(scene: Scene)
  get count(): number
  keys(): string[]
  /**
   * Rebuild overlays to exactly match `refs`. `meshOf` resolves an object id
   * to its CURRENT mesh, so a rebuilt mesh simply produces a fresh overlay.
   */
  sync(
    refs: readonly FaceRef[],
    meshOf: (objectId: string) => AbstractMesh | null,
    hover?: FaceRef | null,
  ): void
  clear(): void
  dispose(): void
  private build
}
//# sourceMappingURL=faceSelection.d.ts.map
