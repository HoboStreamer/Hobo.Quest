import type { FaceStyle, MapLight, StaticBody } from './schema/world.js'
import type { SurfaceMaterialData } from './surface.js'
import type { MapNodeSpawn, MapOverride, MapPropSpawn } from './terrain.js'

/**
 * The edited-map artifact produced by the /editor tool and consumed by the
 * game (server AND client). Heights are base64 Float32; the splat mix is a
 * PNG data URL; extra statics append to the world definition. Model/glTF
 * imports become new entries here in a later phase — the format is the
 * contract, the tools are replaceable.
 */
/**
 * Editor-placed light. Covers every Babylon punctual/ambient light type:
 * point, spot (angle+exponent), directional (sun-like), hemispheric
 * (ambient dome with ground color) and rectangular area lights.
 *
 * The shape lives in `schema/world.ts` as `MapLightSchema` so there is ONE
 * definition: this used to be a hand-written interface next to an untyped
 * `z.record(unknown)` on the wire, which meant an authored light was
 * validated nowhere and could reach Babylon malformed.
 */
export type { MapLight } from './schema/world.js'

/**
 * v1 seeds predate stable document ids. The migration assigns one to every
 * object it carries forward, so nothing downstream of `parseMapFile` has to
 * cope with an identity-less map object.
 */
export type LegacyNodeSpawn = Omit<MapNodeSpawn, 'id'> & { id?: string }
export type LegacyPropSpawn = Omit<MapPropSpawn, 'id'> & { id?: string }

/** A custom texture: either embedded (legacy dataUrl) or server-hosted. */
export interface MapTextureEntry {
  name: string
  /** Legacy embedded payload (small uploads from older maps). */
  dataUrl?: string
  /** Server-hosted asset path (/map-assets/...), preferred. */
  url?: string
  /** Default UV tiling scale hint. */
  scale?: number
}

export interface MapFile {
  v: 1
  halfExtent: number
  sub: number
  /** base64 of Float32Array little-endian heights, (sub+1)^2 entries. */
  heights: string
  /** PNG data URL painted splat mix (R grass / G rock / B mud), optional. */
  mix?: string
  /** Editor-placed statics appended to the world def. */
  statics: StaticBody[]
  /** Editor-placed resource nodes (trees, deposits, piles…). */
  nodes?: LegacyNodeSpawn[]
  /** Props seeded into FRESH worlds (crates, barrels, merchant stalls). */
  props?: LegacyPropSpawn[]
  /** Extra sculptable terrain patches (mountains, cave shells…). */
  terrains?: {
    id: string
    origin: [number, number, number]
    halfExtent: number
    sub: number
    heights: string
    rot?: [number, number, number]
    /** Canonical scale (X/Z footprint, Y height displacement). */
    scale?: [number, number, number]
    tex?: string
    color?: string
    mix?: string
    uv?: FaceStyle
    /** Base style + paint layers (v2 surface model). */
    surface?: SurfaceMaterialData
  }[]
  /** Imported glTF models (data URLs) placeable as statics via `model`. */
  models?: { id: string; name: string; glb: string; bounds: [number, number, number] }[]
  /** Uploaded custom textures usable on statics as `custom:<name>`. */
  textures?: MapTextureEntry[]
  /** Editor-placed lights (rendered client-side). */
  lights?: MapLight[]
  /** Player spawn point + facing. */
  spawn?: [number, number, number]
  spawnYaw?: number
}

export function decodeHeights(b64: string): Float32Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Float32Array(bytes.buffer)
}

export function encodeHeights(heights: Float32Array): string {
  const bytes = new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] as number)
  return typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64')
}

/**
 * Legacy v1 → runtime, by way of the v2 migration. v1 input is still
 * accepted; it is just never the runtime representation.
 */
export function mapFileToOverride(_map: MapFile): MapOverride {
  // Implemented in mapFileV2.ts to avoid an import cycle; see compileV1.
  throw new Error('mapFileToOverride: use parseMapFile() + compileMapFileV2()')
}
