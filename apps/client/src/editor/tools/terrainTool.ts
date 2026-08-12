/**
 * Terrain sculpting: the brush maths, and the rule that one stroke is one
 * history entry holding only what changed.
 *
 * The heightfield the brush edits is the TerrainView's decoded working
 * buffer. Writing it back to the document as base64 on every dab would
 * re-encode a quarter of a million floats per frame, so the stroke edits the
 * buffer live and commits once on release — the same shape as a gizmo drag.
 */
export type SculptMode = 'sculpt' | 'smooth' | 'flatten'

export interface BrushSettings {
  radius: number
  strength: number
  feather: number
}

export interface SculptTarget {
  heights: Float32Array
  /** Grid subdivisions; the field is (sub+1)². */
  sub: number
  /** Half-width in metres. */
  halfExtent: number
}

/**
 * Apply one brush dab at terrain-local (px, pz). `sign` is +1 to raise and
 * -1 to lower. Mutates `target.heights` in place; the caller refreshes the
 * mesh and, on release, computes the delta for history.
 */
export function sculptDab(
  target: SculptTarget,
  px: number,
  pz: number,
  sign: number,
  mode: SculptMode,
  brush: BrushSettings,
): void {
  const { radius, feather } = brush
  const strength = brush.strength * sign
  const n = target.sub
  const half = target.halfExtent
  const cell = (half * 2) / n
  const hs = target.heights

  let flatH = 0
  if (mode === 'flatten') {
    // Flatten takes its target height from where the stroke STARTED being
    // applied, so dragging across a slope levels it to one plane rather
    // than chasing the height under the cursor.
    const ci = Math.round((px + half) / cell)
    const cj = Math.round((pz + half) / cell)
    flatH = hs[cj * (n + 1) + ci] ?? 0
  }

  // Only the samples the brush can actually reach.
  const iMin = Math.max(0, Math.floor((px - radius + half) / cell))
  const iMax = Math.min(n, Math.ceil((px + radius + half) / cell))
  const jMin = Math.max(0, Math.floor((pz - radius + half) / cell))
  const jMax = Math.min(n, Math.ceil((pz + radius + half) / cell))

  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
      const x = -half + i * cell
      const z = -half + j * cell
      const d = Math.hypot(x - px, z - pz)
      if (d > radius) continue
      // Feather is an exponent on a cos² falloff: low gives a wide soft
      // skirt (paths, gentle mounds), high a tight hard-edged plateau.
      const fall = Math.cos((d / radius) * Math.PI * 0.5) ** (2 * feather)
      const v = j * (n + 1) + i
      const h = hs[v] ?? 0
      if (mode === 'sculpt') hs[v] = h + strength * fall * 0.35
      else if (mode === 'flatten') hs[v] = h + (flatH - h) * Math.min(1, fall * 0.6)
      else {
        const neighbours =
          ((hs[v - 1] ?? h) + (hs[v + 1] ?? h) + (hs[v - (n + 1)] ?? h) + (hs[v + (n + 1)] ?? h)) /
          4
        hs[v] = h + (neighbours - h) * Math.min(1, fall * 0.8)
      }
    }
  }
}

/**
 * World point → terrain-local, accounting for the terrain's own transform.
 * Sculpting a rotated or scaled terrain has to land where the cursor is, not
 * where it would be if the terrain were at the origin.
 */
export function toTerrainLocal(
  world: { x: number; y: number; z: number },
  pos: readonly [number, number, number],
  rot: readonly [number, number, number] | undefined,
  scale: readonly [number, number, number] | undefined,
): { x: number; y: number; z: number } {
  let x = world.x - pos[0]
  let y = world.y - pos[1]
  let z = world.z - pos[2]
  if (rot) {
    // Inverse of the Y-then-X-then-Z Euler the view applies. Terrain is
    // almost always yaw-only, so the common path stays cheap.
    const cy = Math.cos(-rot[1])
    const sy = Math.sin(-rot[1])
    const nx = x * cy - z * sy
    const nz = x * sy + z * cy
    x = nx
    z = nz
  }
  if (scale) {
    x /= scale[0] || 1
    y /= scale[1] || 1
    z /= scale[2] || 1
  }
  return { x, y, z }
}
