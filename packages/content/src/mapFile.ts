import type { StaticBody } from './schema/world.js'
import type { MapOverride } from './terrain.js'

/**
 * The edited-map artifact produced by the /editor tool and consumed by the
 * game (server AND client). Heights are base64 Float32; the splat mix is a
 * PNG data URL; extra statics append to the world definition. Model/glTF
 * imports become new entries here in a later phase — the format is the
 * contract, the tools are replaceable.
 */
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
  return { halfExtent: map.halfExtent, sub: map.sub, heights: decodeHeights(map.heights) }
}
