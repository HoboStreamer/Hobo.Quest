/**
 * Layered surface material data — the paint model shared by editor and game.
 *
 * The old system was Babylon's TerrainMaterial: exactly three hard-coded
 * textures (grass / rock / mud) blended by an RGB mix map. Choosing the Paint
 * tool therefore REPLACED whatever texture the surface had with that fixed
 * palette, and no other texture could ever be painted.
 *
 * Here a surface is a BASE style plus up to four paint layers. The base is
 * never touched by painting — it shows wherever no layer covers it — and each
 * layer references any registered texture (stock or custom upload). The four
 * layers' coverage packs into the RGBA channels of one mask image, so a
 * surface costs 1 base + 4 layer + 1 mask = 6 samplers regardless of how many
 * textures the project has.
 */
import type { FaceStyle } from './schema/world.js'

/** RGBA gives four independent coverage channels per mask image. */
export const MAX_PAINT_LAYERS = 4
export const PAINT_CHANNELS = ['r', 'g', 'b', 'a'] as const
export type PaintChannel = (typeof PAINT_CHANNELS)[number]

/** A surface's underlying look: what shows where nothing is painted. */
export interface SurfaceStyle {
  /** Texture ref: stock basename, `custom:<name>`, or 'none' for plain colour. */
  tex?: string
  /** Tint / plain colour (hex). */
  color?: string
  /** UV transform (face-edit tool). */
  uv?: FaceStyle
}

export interface PaintLayer {
  id: string
  /**
   * Texture ref, same vocabulary as SurfaceStyle.tex. The sentinel 'none'
   * paints a PLAIN COLOUR — no texture sampled, just `color`.
   */
  tex: string
  /**
   * Tint multiplied into the layer. With a texture it tints the texture;
   * with tex 'none' it IS the paint. Absent = untinted white.
   */
  color?: string
  /** Metres per tile; falls back to the texture registry's default. */
  scale?: number
  /** Which mask channel carries this layer's coverage. */
  channel: PaintChannel
  /** Author-facing toggle; a hidden layer keeps its mask. */
  hidden?: boolean
}

export interface SurfacePaint {
  layers: PaintLayer[]
  /**
   * RGBA coverage mask. Either an embedded data URL (legacy / offline) or a
   * content-addressed `/map-assets/<hash>.png` path.
   */
  mask?: string
}

export interface SurfaceMaterialData {
  base: SurfaceStyle
  paint?: SurfacePaint
}

export const emptySurface = (base: SurfaceStyle = {}): SurfaceMaterialData => ({ base })

/** Layers that actually contribute, in channel order. */
export function activeLayers(paint: SurfacePaint | undefined): PaintLayer[] {
  if (!paint) return []
  return paint.layers.filter((l) => !l.hidden)
}

/**
 * A layer is identified by its texture AND its tint: painting red brick and
 * blue brick are two different paints, so they get two channels rather than
 * one silently restyling the other.
 */
export const sameLayerStyle = (l: PaintLayer, tex: string, color?: string): boolean =>
  l.tex === tex && (l.color ?? '') === (color ?? '')

export function layerForTexture(
  paint: SurfacePaint | undefined,
  tex: string,
  color?: string,
): PaintLayer | null {
  return paint?.layers.find((l) => sameLayerStyle(l, tex, color)) ?? null
}

export function freeChannel(paint: SurfacePaint | undefined): PaintChannel | null {
  const used = new Set((paint?.layers ?? []).map((l) => l.channel))
  return PAINT_CHANNELS.find((c) => !used.has(c)) ?? null
}

export interface LayerAllocation {
  paint: SurfacePaint
  layer: PaintLayer
  /** True when this call created the layer rather than reusing one. */
  created: boolean
}

/**
 * Get the layer for `tex`, creating one if a channel is free.
 *
 * Returns null when the surface is already at its layer budget — the caller
 * must then surface the layer manager rather than silently swapping a
 * texture out, which is exactly the behaviour the old palette had.
 */
export function allocateLayer(
  paint: SurfacePaint | undefined,
  tex: string,
  makeId: () => string,
  color?: string,
): LayerAllocation | null {
  const current: SurfacePaint = paint ?? { layers: [] }
  const existing = layerForTexture(current, tex, color)
  if (existing) {
    // A hidden layer becomes visible again rather than duplicating.
    if (existing.hidden) delete existing.hidden
    return { paint: current, layer: existing, created: false }
  }
  const channel = freeChannel(current)
  if (!channel) return null
  const layer: PaintLayer = { id: makeId(), tex, channel, ...(color ? { color } : {}) }
  current.layers.push(layer)
  return { paint: current, layer, created: true }
}

/** Remove a layer; its mask channel becomes free for the next texture. */
export function removeLayer(paint: SurfacePaint, layerId: string): PaintChannel | null {
  const i = paint.layers.findIndex((l) => l.id === layerId)
  if (i < 0) return null
  const [gone] = paint.layers.splice(i, 1)
  return gone?.channel ?? null
}

/**
 * Migrate a legacy three-way splat (R grass / G rock / B mud) into v2 paint
 * layers. The channel assignment is preserved exactly, so an old map's
 * painted ground renders identically after migration.
 */
export function migrateLegacyMix(
  mix: string | undefined,
  makeId: () => string,
): SurfacePaint | undefined {
  if (!mix) return undefined
  return {
    mask: mix,
    layers: [
      { id: makeId(), tex: 'leafy_grass', channel: 'r' },
      { id: makeId(), tex: 'gray_rocks', channel: 'g' },
      { id: makeId(), tex: 'brown_mud_dry', channel: 'b' },
    ],
  }
}

/** Validation for the Issues panel and the save pipeline. */
export function validateSurface(
  s: SurfaceMaterialData,
  textureExists: (ref: string) => boolean,
): string[] {
  const issues: string[] = []
  if (s.base.tex && s.base.tex !== 'none' && !textureExists(s.base.tex))
    issues.push(`missing base texture "${s.base.tex}"`)
  const paint = s.paint
  if (!paint) return issues
  if (paint.layers.length > MAX_PAINT_LAYERS)
    issues.push(`${paint.layers.length} paint layers exceeds the ${MAX_PAINT_LAYERS} supported`)
  const seen = new Set<PaintChannel>()
  for (const l of paint.layers) {
    // 'none' is a plain-colour layer, not a texture reference.
    if (l.tex !== 'none' && !textureExists(l.tex)) issues.push(`missing paint texture "${l.tex}"`)
    if (l.tex === 'none' && !l.color) issues.push('a plain-colour paint layer has no colour')
    if (seen.has(l.channel)) issues.push(`two paint layers share channel ${l.channel}`)
    seen.add(l.channel)
  }
  if (paint.layers.length > 0 && !paint.mask)
    issues.push('paint layers exist but the mask is missing')
  return issues
}
