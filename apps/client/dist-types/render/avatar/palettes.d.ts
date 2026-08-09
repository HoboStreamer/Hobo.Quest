/**
 * Avatar color palettes. The wire format carries indices; only the client
 * knows colors, so palettes can be retuned freely. Index ranges must stay
 * >= the bounds in @hobo/protocol AppearanceSchema.
 */
export declare const SKIN_TONES: readonly [
  '#f2d0b4',
  '#eabf9c',
  '#d9a878',
  '#c68e5f',
  '#a96f45',
  '#8a5433',
  '#6b3f26',
  '#54301c',
]
export declare const HAIR_COLORS: readonly [
  '#241a12',
  '#3d2a1a',
  '#5c3f24',
  '#8a5a2e',
  '#b8863f',
  '#d8b169',
  '#9c3b22',
  '#8d8d93',
]
export declare const OUTFIT_COLORS: readonly [
  '#e8e4da',
  '#b8b4ac',
  '#5f6a72',
  '#3c4854',
  '#6d5a3e',
  '#4a6b52',
  '#7a3b32',
  '#3e5a7a',
  '#8a7a2e',
  '#2e2a28',
]
export declare function skinTone(i: number): string
export declare function hairColor(i: number): string
export declare function outfitColor(i: number): string
//# sourceMappingURL=palettes.d.ts.map
