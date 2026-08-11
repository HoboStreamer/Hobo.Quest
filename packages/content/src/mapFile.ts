import type { FaceStyle, StaticBody } from './schema/world.js'
import type { MapNodeSpawn, MapOverride, MapPropSpawn, TerrainPatchData } from './terrain.js'

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
 */
export interface MapLight {
  id: string
  type: 'point' | 'spot' | 'directional' | 'hemi' | 'rect'
  pos: [number, number, number]
  /** Direction for spot/directional/hemi/rect (unit-ish vector). */
  dir?: [number, number, number]
  /** Diffuse color (hex). */
  color?: string
  /** Specular highlight color (hex). */
  specular?: string
  intensity?: number
  /** Reach in meters (point/spot). */
  range?: number
  /** Spot cone angle in radians. */
  angle?: number
  /** Spot decay exponent. */
  exponent?: number
  /** Hemispheric ground (bounce) color. */
  ground?: string
  /** Rect area light [width, height] in meters. */
  size?: [number, number]
  /** Cast shadows (spot/directional/point). */
  shadows?: boolean
}

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
  nodes?: MapNodeSpawn[]
  /** Props seeded into FRESH worlds (crates, barrels, merchant stalls). */
  props?: MapPropSpawn[]
  /** Extra sculptable terrain patches (mountains, cave shells…). */
  terrains?: {
    id: string
    origin: [number, number, number]
    halfExtent: number
    sub: number
    heights: string
    rot?: [number, number, number]
    tex?: string
    color?: string
    mix?: string
    uv?: FaceStyle
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

export function mapFileToOverride(map: MapFile): MapOverride {
  return {
    halfExtent: map.halfExtent,
    sub: map.sub,
    heights: decodeHeights(map.heights),
    nodes: map.nodes ?? [],
    props: map.props ?? [],
    terrains: (map.terrains ?? []).map((t): TerrainPatchData => ({
      ...t,
      heights: decodeHeights(t.heights),
    })),
    ...(map.spawn ? { spawn: map.spawn } : {}),
    ...(map.spawnYaw !== undefined ? { spawnYaw: map.spawnYaw } : {}),
  }
}
