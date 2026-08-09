/**
 * Avatar color palettes. The wire format carries indices; only the client
 * knows colors, so palettes can be retuned freely. Index ranges must stay
 * >= the bounds in @hobo/protocol AppearanceSchema.
 */

export const SKIN_TONES = [
  '#f2d0b4',
  '#eabf9c',
  '#d9a878',
  '#c68e5f',
  '#a96f45',
  '#8a5433',
  '#6b3f26',
  '#54301c',
] as const

export const HAIR_COLORS = [
  '#241a12', // near black
  '#3d2a1a', // dark brown
  '#5c3f24', // brown
  '#8a5a2e', // light brown
  '#b8863f', // dark blond
  '#d8b169', // blond
  '#9c3b22', // ginger
  '#8d8d93', // grey
] as const

export const OUTFIT_COLORS = [
  '#e8e4da', // off-white
  '#b8b4ac', // light grey
  '#5f6a72', // slate
  '#3c4854', // dark slate
  '#6d5a3e', // tan
  '#4a6b52', // forest
  '#7a3b32', // rust
  '#3e5a7a', // denim
  '#8a7a2e', // olive
  '#2e2a28', // charcoal
] as const

export function skinTone(i: number): string {
  return SKIN_TONES[i % SKIN_TONES.length] as string
}

export function hairColor(i: number): string {
  return HAIR_COLORS[i % HAIR_COLORS.length] as string
}

export function outfitColor(i: number): string {
  return OUTFIT_COLORS[i % OUTFIT_COLORS.length] as string
}
