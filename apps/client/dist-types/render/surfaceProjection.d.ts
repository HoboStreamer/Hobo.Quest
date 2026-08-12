/**
 * Surface projections — the geometry of "where on this thing did the brush
 * land", shared by the editor that paints and the renderer that displays it.
 *
 * These live under render/ rather than under the editor because BOTH sides
 * need them and the dependency has to point one way: the game must never
 * import editor code. If the two disagreed by even a sign, paint would appear
 * in one place in the editor and another in the game.
 *
 * Pure functions over plain numbers: no Babylon values, no scene, no state.
 */
import type { StaticObjectV2 } from '@hobo/content'
/**
 * Which box face a normal belongs to, in Babylon's face order
 * (0 +z, 1 -z, 2 +x, 3 -x, 4 +y, 5 -y). Painting one wall of a room must
 * not paint the other five.
 */
export declare function faceIndexFromNormal(n: { x: number; y: number; z: number }): number
/** Local point on a box face → 0..1 UV across that face. */
export declare function faceUV(
  local: {
    x: number
    y: number
    z: number
  },
  size: readonly [number, number, number],
  face: number,
): {
  u: number
  v: number
}
/** Cylindrical wrap: angle around Y, height along it. Seam at -X. */
export declare function cylindricalUV(
  local: {
    x: number
    y: number
    z: number
  },
  height: number,
): {
  u: number
  v: number
}
/**
 * Spherical wrap. The poles compress to a point, so a stamp there covers a
 * wide band of u — clamped rather than left to smear, which is the least
 * surprising of the available wrong answers.
 */
export declare function sphericalUV(local: { x: number; y: number; z: number }): {
  u: number
  v: number
}
/** Terrain: local metres → 0..1 across the patch. */
export declare function planarUV(
  local: {
    x: number
    z: number
  },
  halfExtent: number,
): {
  u: number
  v: number
}
/**
 * Box projection for meshes with no usable UV0.
 *
 * The alternative is for Paint to silently do nothing on an imported model,
 * which is the worst outcome: the user cannot tell whether they missed, the
 * texture failed to load, or the feature does not work. Projecting from the
 * dominant axis is approximate — it stretches on faces oblique to that axis
 * — so the Inspector says so and the Issues panel raises it.
 */
export declare function boxProjectionUV(
  local: {
    x: number
    y: number
    z: number
  },
  normal: {
    x: number
    y: number
    z: number
  },
  extents: readonly [number, number, number],
): {
  u: number
  v: number
}
/** True when a mesh can be painted in its own UV space. */
export declare function hasUsableUV0(mesh: {
  isVerticesDataPresent: (kind: string) => boolean
  getVerticesData: (kind: string) => Float32Array | number[] | null
}): boolean
/**
 * The world-space size of a static's authored shape. For an imported model
 * this is the proxy volume the importer measured, which is also the space the
 * box-projection fallback is expressed in — so the brush and the renderer
 * agree about scale.
 */
export declare const staticExtent: (
  shape: StaticObjectV2['shape'],
  scale?: readonly number[],
) => [number, number, number]
//# sourceMappingURL=surfaceProjection.d.ts.map
