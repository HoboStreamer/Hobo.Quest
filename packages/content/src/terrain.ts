import type { WorldDef } from './schema/world.js'

/**
 * Deterministic terrain heightfield shared by server physics, client
 * prediction physics and client rendering — all three MUST sample the
 * exact same function or players mispredict on every hill.
 *
 * Height = smooth value noise, faded to zero around the city and under
 * every authored static (walls, ramps, buildings sit on flat pads). The
 * world def is data; nothing here knows what a "city" is beyond its rect.
 */

/** Grid cell size in meters (physics + render resolution). */
export const TERRAIN_CELL = 1.25

/** Water surface height — terrain dips below this become lakes; beyond the
 * map edge the same sheet reads as the ocean around the island. */
export const WATER_LEVEL = -0.42

// ── Value noise (deterministic, no RNG state) ────────────────────────

function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t)
}

function valueNoise(x: number, z: number): number {
  const ix = Math.floor(x)
  const iz = Math.floor(z)
  const fx = smooth(x - ix)
  const fz = smooth(z - iz)
  const a = hash2(ix, iz)
  const b = hash2(ix + 1, iz)
  const c = hash2(ix, iz + 1)
  const d = hash2(ix + 1, iz + 1)
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz
}

/** Raw rolling-hills elevation before any flattening. */
function rawHeight(x: number, z: number): number {
  return (
    (valueNoise(x / 26 + 100, z / 26 + 100) - 0.5) * 3.6 +
    (valueNoise(x / 9.5 + 40, z / 9.5 + 40) - 0.5) * 1.1 +
    (valueNoise(x / 3.7 + 7, z / 3.7 + 7) - 0.5) * 0.28
  )
}

/** 0 inside a pad rect, ramping to 1 over `ramp` meters outside it. */
function padMask(
  x: number,
  z: number,
  cx: number,
  cz: number,
  hx: number,
  hz: number,
  ramp: number,
): number {
  const dx = Math.max(0, Math.abs(x - cx) - hx)
  const dz = Math.max(0, Math.abs(z - cz) - hz)
  const d = Math.hypot(dx, dz)
  return smooth(Math.min(1, d / ramp))
}

interface Pad {
  cx: number
  cz: number
  hx: number
  hz: number
  ramp: number
}

const padCache = new WeakMap<WorldDef, Pad[]>()

function padsFor(world: WorldDef): Pad[] {
  let pads = padCache.get(world)
  if (pads) return pads
  pads = [
    // The whole walled city sits on a plain.
    { cx: 0, cz: 0, hx: 27, hz: 27, ramp: 12 },
  ]
  for (const s of world.statics) {
    // Ground-standing statics get a flat pad under their footprint so they
    // neither float nor sink when the noise rolls under them.
    const [hx, , hz] =
      s.shape.type === 'box'
        ? [s.shape.size[0] / 2, 0, s.shape.size[2] / 2]
        : [s.shape.radius, 0, s.shape.radius]
    pads.push({ cx: s.pos[0], cz: s.pos[2], hx: hx + 1.5, hz: hz + 1.5, ramp: 5 })
  }
  padCache.set(world, pads)
  return pads
}

// ── Edited-map override ──────────────────────────────────────────────
// When a hand-edited map (from the /editor tool) is loaded, its heightfield
// replaces the procedural noise everywhere — server physics, client
// prediction and rendering all sample the same grid.

export interface MapNodeSpawn {
  id?: string
  node: string
  pos: [number, number, number]
}

export interface MapPropSpawn {
  id?: string
  item: string
  pos: [number, number, number]
  yaw?: number
}

export interface TerrainPatchData {
  id: string
  origin: [number, number, number]
  halfExtent: number
  sub: number
  heights: Float32Array
  /** Euler rotation — tilt patches into overhangs and cave roofs. */
  rot?: [number, number, number]
  /** Tiling texture basename (or custom:<name>); default grass. */
  tex?: string
  /** Tint color (hex). */
  color?: string
}

export interface MapOverride {
  /** Editor-placed resource nodes (trees, deposits…) merged into seeding. */
  nodes?: MapNodeSpawn[]
  /** Editor-placed initial props merged into fresh-world seeding. */
  props?: MapPropSpawn[]
  /** Extra sculptable terrain meshes (mountains, cave shells…). */
  terrains?: TerrainPatchData[]
  /** Editor-placed spawn point (overrides the world def). */
  spawn?: [number, number, number]
  spawnYaw?: number

  halfExtent: number
  /** Grid points per side (sub+1 columns). */
  sub: number
  /** Row-major heights, (sub+1)^2 entries, row 0 at -z. */
  heights: Float32Array
}

let mapOverride: MapOverride | null = null

export function setMapOverride(map: MapOverride | null): void {
  mapOverride = map
}

export function getMapOverride(): MapOverride | null {
  return mapOverride
}

function sampleOverride(map: MapOverride, x: number, z: number): number {
  const cell = (map.halfExtent * 2) / map.sub
  const fx = Math.min(Math.max((x + map.halfExtent) / cell, 0), map.sub - 1e-6)
  const fz = Math.min(Math.max((z + map.halfExtent) / cell, 0), map.sub - 1e-6)
  const ix = Math.floor(fx)
  const iz = Math.floor(fz)
  const tx = fx - ix
  const tz = fz - iz
  const w = map.sub + 1
  const h00 = map.heights[iz * w + ix] ?? 0
  const h10 = map.heights[iz * w + ix + 1] ?? 0
  const h01 = map.heights[(iz + 1) * w + ix] ?? 0
  const h11 = map.heights[(iz + 1) * w + ix + 1] ?? 0
  return h00 * (1 - tx) * (1 - tz) + h10 * tx * (1 - tz) + h01 * (1 - tx) * tz + h11 * tx * tz
}

/** Terrain elevation at world (x, z). */
export function terrainHeight(world: WorldDef, x: number, z: number): number {
  if (mapOverride) return sampleOverride(mapOverride, x, z)
  if (world.flatTerrain) return 0
  let mask = 1
  for (const pad of padsFor(world)) {
    const m = padMask(x, z, pad.cx, pad.cz, pad.hx, pad.hz, pad.ramp)
    if (m < mask) mask = m
    if (mask === 0) return 0
  }
  return rawHeight(x, z) * mask
}

export interface TerrainGrid {
  positions: Float32Array
  indices: Uint32Array
  uvs: Float32Array
  /** Cells per side. */
  sub: number
  /** Half extent in meters. */
  halfExtent: number
}

/** The procedural heights as a flat grid (editor starting point). */
export function defaultHeights(world: WorldDef, sub: number): Float32Array {
  const half = world.groundHalfExtent
  const heights = new Float32Array((sub + 1) * (sub + 1))
  const saved = mapOverride
  mapOverride = null
  for (let j = 0; j <= sub; j++) {
    for (let i = 0; i <= sub; i++) {
      heights[j * (sub + 1) + i] = terrainHeight(
        world,
        -half + (i * half * 2) / sub,
        -half + (j * half * 2) / sub,
      )
    }
  }
  mapOverride = saved
  return heights
}

/** Full displaced grid (positions/indices/uvs) for physics + rendering. */
export function buildTerrainGrid(world: WorldDef): TerrainGrid {
  const half = world.groundHalfExtent
  const sub = Math.round((half * 2) / TERRAIN_CELL)
  const verts = (sub + 1) * (sub + 1)
  const positions = new Float32Array(verts * 3)
  const uvs = new Float32Array(verts * 2)
  const indices = new Uint32Array(sub * sub * 6)
  // Vertex layout + index winding copied verbatim from Babylon's ground
  // builder (row 0 at +z, z decreasing with row) so faces are guaranteed
  // front-side-up under Babylon's culling.
  let p = 0
  let u = 0
  for (let row = 0; row <= sub; row++) {
    for (let col = 0; col <= sub; col++) {
      const x = (col * (half * 2)) / sub - half
      const z = ((sub - row) * (half * 2)) / sub - half
      positions[p++] = x
      positions[p++] = terrainHeight(world, x, z)
      positions[p++] = z
      uvs[u++] = col / sub
      uvs[u++] = 1 - row / sub // v grows with +z
    }
  }
  let t = 0
  for (let row = 0; row < sub; row++) {
    for (let col = 0; col < sub; col++) {
      indices[t++] = col + 1 + (row + 1) * (sub + 1)
      indices[t++] = col + 1 + row * (sub + 1)
      indices[t++] = col + row * (sub + 1)
      indices[t++] = col + (row + 1) * (sub + 1)
      indices[t++] = col + 1 + (row + 1) * (sub + 1)
      indices[t++] = col + row * (sub + 1)
    }
  }
  return { positions, indices, uvs, sub, halfExtent: half }
}

/**
 * Grid for a free-floating terrain patch, in PATCH-LOCAL space (origin at
 * the patch center, unrotated) — same layout/winding as the main ground so
 * rendering and trimesh physics reuse it on both sides of the wire.
 */
export function buildPatchGrid(
  halfExtent: number,
  sub: number,
  heights: Float32Array,
): TerrainGrid {
  const verts = (sub + 1) * (sub + 1)
  const positions = new Float32Array(verts * 3)
  const uvs = new Float32Array(verts * 2)
  const indices = new Uint32Array(sub * sub * 6)
  let p = 0
  let u = 0
  for (let row = 0; row <= sub; row++) {
    for (let col = 0; col <= sub; col++) {
      const x = (col * (halfExtent * 2)) / sub - halfExtent
      const z = ((sub - row) * (halfExtent * 2)) / sub - halfExtent
      const j = Math.round((z + halfExtent) / ((halfExtent * 2) / sub))
      positions[p++] = x
      positions[p++] = heights[j * (sub + 1) + col] ?? 0
      positions[p++] = z
      uvs[u++] = col / sub
      uvs[u++] = 1 - row / sub
    }
  }
  let t = 0
  for (let row = 0; row < sub; row++) {
    for (let col = 0; col < sub; col++) {
      indices[t++] = col + 1 + (row + 1) * (sub + 1)
      indices[t++] = col + 1 + row * (sub + 1)
      indices[t++] = col + row * (sub + 1)
      indices[t++] = col + (row + 1) * (sub + 1)
      indices[t++] = col + 1 + (row + 1) * (sub + 1)
      indices[t++] = col + row * (sub + 1)
    }
  }
  return { positions, indices, uvs, sub, halfExtent }
}

/** Spawn point honoring the edited map (blank worlds place their own). */
export function worldSpawn(world: WorldDef): {
  pos: [number, number, number]
  yaw: number
} {
  const o = mapOverride
  return {
    pos: o?.spawn ?? [world.spawnPoint[0], world.spawnPoint[1], world.spawnPoint[2]],
    yaw: o?.spawnYaw ?? world.spawnYaw,
  }
}
