import { Mesh } from '@babylonjs/core/Meshes/mesh.js'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData.js'
import type { Scene } from '@babylonjs/core/scene.js'

/**
 * Flat-shaded tapered box — the single primitive the whole low-poly avatar
 * is assembled from (equal top/bottom sizes = plain box). Origin sits at
 * the anchor face so segments rotate naturally from their joint:
 * `anchor: 'top'` hangs downward (limbs), `'bottom'` grows upward (torso).
 * Optional forward offsets shear the profile for a hand-modeled feel.
 */
export interface TaperedBoxOpts {
  topWidth: number
  topDepth: number
  bottomWidth: number
  bottomDepth: number
  height: number
  anchor: 'top' | 'bottom'
  /** Shift (m) of the top/bottom face along +Z — gives shear/posture. */
  topShiftZ?: number
  bottomShiftZ?: number
}

export function createTaperedBox(name: string, opts: TaperedBoxOpts, scene: Scene): Mesh {
  const { topWidth, topDepth, bottomWidth, bottomDepth, height, anchor } = opts
  const tz = opts.topShiftZ ?? 0
  const bz = opts.bottomShiftZ ?? 0
  const yTop = anchor === 'top' ? 0 : height
  const yBot = anchor === 'top' ? -height : 0

  const tw = topWidth / 2
  const td = topDepth / 2
  const bw = bottomWidth / 2
  const bd = bottomDepth / 2

  // 8 corners (t = top, b = bottom; winding assembled per face below)
  const t0 = [-tw, yTop, -td + tz]
  const t1 = [tw, yTop, -td + tz]
  const t2 = [tw, yTop, td + tz]
  const t3 = [-tw, yTop, td + tz]
  const b0 = [-bw, yBot, -bd + bz]
  const b1 = [bw, yBot, -bd + bz]
  const b2 = [bw, yBot, bd + bz]
  const b3 = [-bw, yBot, bd + bz]

  const positions: number[] = []
  const indices: number[] = []

  // Each face gets its own 4 vertices so normals stay flat (low-poly look).
  const face = (a: number[], b: number[], c: number[], d: number[]): void => {
    const base = positions.length / 3
    positions.push(...a, ...b, ...c, ...d)
    // Clockwise winding — Babylon (left-handed) culls counter-clockwise
    // faces, and getting this backwards renders the whole body inside-out.
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2)
  }

  face(t3, t2, t1, t0) // top (+y)
  face(b0, b1, b2, b3) // bottom (-y)
  face(t0, t1, b1, b0) // back (-z)
  face(t2, t3, b3, b2) // front (+z)
  face(t3, t0, b0, b3) // left (-x)
  face(t1, t2, b2, b1) // right (+x)

  const normals: number[] = []
  VertexData.ComputeNormals(positions, indices, normals)

  const data = new VertexData()
  data.positions = positions
  data.indices = indices
  data.normals = normals

  const mesh = new Mesh(name, scene)
  data.applyToMesh(mesh)
  return mesh
}
