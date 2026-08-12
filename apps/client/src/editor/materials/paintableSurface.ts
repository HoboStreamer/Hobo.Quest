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

/**
 * Which box face a normal belongs to, in Babylon's face order
 * (0 +z, 1 -z, 2 +x, 3 -x, 4 +y, 5 -y). Painting one wall of a room must
 * not paint the other five.
 */
export function faceIndexFromNormal(n: { x: number; y: number; z: number }): number {
  const ax = Math.abs(n.x)
  const ay = Math.abs(n.y)
  const az = Math.abs(n.z)
  if (az >= ax && az >= ay) return n.z >= 0 ? 0 : 1
  if (ax >= ay) return n.x >= 0 ? 2 : 3
  return n.y >= 0 ? 4 : 5
}

/** Local point on a box face → 0..1 UV across that face. */
export function faceUV(
  local: { x: number; y: number; z: number },
  size: readonly [number, number, number],
  face: number,
): { u: number; v: number } {
  const [w, h, d] = size
  switch (face) {
    case 0:
      return { u: 0.5 + local.x / w, v: 0.5 - local.y / h }
    case 1:
      return { u: 0.5 - local.x / w, v: 0.5 - local.y / h }
    case 2:
      return { u: 0.5 - local.z / d, v: 0.5 - local.y / h }
    case 3:
      return { u: 0.5 + local.z / d, v: 0.5 - local.y / h }
    case 4:
      return { u: 0.5 + local.x / w, v: 0.5 + local.z / d }
    default:
      return { u: 0.5 + local.x / w, v: 0.5 - local.z / d }
  }
}

/** Cylindrical wrap: angle around Y, height along it. Seam at -X. */
export function cylindricalUV(
  local: { x: number; y: number; z: number },
  height: number,
): { u: number; v: number } {
  const angle = Math.atan2(local.z, local.x)
  return { u: (angle + Math.PI) / (Math.PI * 2), v: 0.5 - local.y / Math.max(1e-6, height) }
}

/**
 * Spherical wrap. The poles compress to a point, so a stamp there covers a
 * wide band of u — clamped rather than left to smear, which is the least
 * surprising of the available wrong answers.
 */
export function sphericalUV(local: { x: number; y: number; z: number }): { u: number; v: number } {
  const r = Math.hypot(local.x, local.y, local.z) || 1
  const theta = Math.atan2(local.z, local.x)
  const phi = Math.acos(Math.max(-1, Math.min(1, local.y / r)))
  return { u: (theta + Math.PI) / (Math.PI * 2), v: phi / Math.PI }
}

/** Terrain: local metres → 0..1 across the patch. */
export function planarUV(
  local: { x: number; z: number },
  halfExtent: number,
): { u: number; v: number } {
  return {
    u: (local.x + halfExtent) / (halfExtent * 2),
    v: 1 - (local.z + halfExtent) / (halfExtent * 2),
  }
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
export function boxProjectionUV(
  local: { x: number; y: number; z: number },
  normal: { x: number; y: number; z: number },
  extents: readonly [number, number, number],
): { u: number; v: number } {
  return faceUV(local, extents, faceIndexFromNormal(normal))
}

/** True when a mesh can be painted in its own UV space. */
export function hasUsableUV0(mesh: {
  isVerticesDataPresent: (kind: string) => boolean
  getVerticesData: (kind: string) => Float32Array | number[] | null
}): boolean {
  if (!mesh.isVerticesDataPresent('uv')) return false
  const uvs = mesh.getVerticesData('uv')
  if (!uvs || uvs.length < 4) return false
  // All-zero UVs are what an exporter writes when the mesh was never
  // unwrapped; painting into that puts every stamp on one texel.
  let spread = 0
  for (let i = 0; i < uvs.length && spread < 1e-4; i += 2) {
    spread = Math.max(spread, Math.abs((uvs[i] ?? 0) - (uvs[0] ?? 0)))
  }
  return spread > 1e-4
}

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
