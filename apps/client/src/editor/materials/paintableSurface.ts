/**
 * Painting, generalised past terrain.
 *
 * Terrain paint worked because a heightfield has one obvious UV
 * parameterisation: local metres map linearly to the mask. A box has six
 * faces that should be paintable independently, a cylinder wraps, a sphere
 * has poles, and an imported GLB may have no usable UVs at all. Rather than
 * a branch per case in the brush, each paintable thing answers the same two
 * questions:
 *
 *   - which surface am I? (a stable id, so the paint can be saved)
 *   - where in my mask is this world-space point?
 *
 * The DOCUMENT holds the surface data. A `PaintableSurface` is a view onto
 * it, exactly like the meshes are.
 */
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh.js'
import type { Vector3 } from '@babylonjs/core/Maths/math.vector.js'
import type { SurfaceMaterialData } from '@hobo/content'
import type { PaintMask } from './paintMask.js'

/** Where a brush stamp lands, in mask pixels. */
export interface PaintUV {
  u: number
  v: number
  /** Brush radius converted from world metres into mask pixels. */
  radiusPixels: number
}

/**
 * How a surface's UVs were derived. Shown in the Inspector and used by the
 * Issues panel, because "the paint went somewhere unexpected" is otherwise
 * indistinguishable from "the paint did nothing".
 */
export type ProjectionMode = 'planar' | 'face' | 'cylindrical' | 'spherical' | 'uv0' | 'box'

export interface PaintableSurface {
  /** Document object that owns this surface. */
  readonly ownerId: string
  /**
   * Stable surface id within the owner: `surface` for a whole object,
   * `face:0`..`face:5` for box faces, `mesh:<node path>/material:<slot>`
   * for an imported model's slots.
   */
  readonly surfaceId: string
  readonly mesh: AbstractMesh
  readonly projection: ProjectionMode
  /** The authoritative data — read from the document, never cached here. */
  getMaterialData(): SurfaceMaterialData
  /** The live mask being painted into. */
  getMask(): PaintMask
  /**
   * World-space pick → mask pixels, or null when this point is not on this
   * surface (a pick on face 3 while face 1 is the active surface).
   */
  mapPickToPaintUV(worldPoint: Vector3, worldNormal: Vector3, brushRadius: number): PaintUV | null
}

// ── Stable surface ids ────────────────────────────────────────────────

export const WHOLE_SURFACE = 'surface'
export const faceSurfaceId = (index: number): string => `face:${index}`
export const modelSurfaceId = (nodePath: string, slot: number): string =>
  `mesh:${nodePath}/material:${slot}`

const FACE_RE = /^face:(\d+)$/

export function parseSurfaceId(
  id: string,
):
  | { kind: 'whole' }
  | { kind: 'face'; index: number }
  | { kind: 'model'; path: string; slot: number }
  | null {
  if (id === WHOLE_SURFACE) return { kind: 'whole' }
  const face = FACE_RE.exec(id)
  if (face) return { kind: 'face', index: Number(face[1]) }
  const model = /^mesh:(.+)\/material:(\d+)$/.exec(id)
  if (model) return { kind: 'model', path: model[1]!, slot: Number(model[2]) }
  return null
}

// ── Projections ───────────────────────────────────────────────────────
//
// The projections themselves live under render/, because the game needs the
// same ones to display what was painted and must not import editor code.
// Re-exported here so the brush reads as one surface vocabulary.
export {
  boxProjectionUV,
  cylindricalUV,
  faceIndexFromNormal,
  faceUV,
  hasUsableUV0,
  planarUV,
  sphericalUV,
  staticExtent,
} from '../../render/surfaceProjection.js'

/** Convert a UV in 0..1 plus a world radius into mask pixels. */
export function toPaintUV(
  uv: { u: number; v: number },
  maskSize: number,
  worldRadius: number,
  worldExtent: number,
): PaintUV {
  return {
    u: uv.u * maskSize,
    v: uv.v * maskSize,
    radiusPixels: Math.max(1, (worldRadius / Math.max(1e-6, worldExtent)) * maskSize),
  }
}
