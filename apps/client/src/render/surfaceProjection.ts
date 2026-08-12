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

/**
 * The world-space size of a static's authored shape. For an imported model
 * this is the proxy volume the importer measured, which is also the space the
 * box-projection fallback is expressed in — so the brush and the renderer
 * agree about scale.
 */
export const staticExtent = (
  shape: StaticObjectV2['shape'],
  scale: readonly number[] = [1, 1, 1],
): [number, number, number] =>
  shape.type === 'box'
    ? [shape.size[0] * scale[0]!, shape.size[1] * scale[1]!, shape.size[2] * scale[2]!]
    : shape.type === 'cylinder'
      ? [shape.radius * 2 * scale[0]!, shape.height * scale[1]!, shape.radius * 2 * scale[2]!]
      : [shape.radius * 2 * scale[0]!, shape.radius * 2 * scale[1]!, shape.radius * 2 * scale[2]!]
