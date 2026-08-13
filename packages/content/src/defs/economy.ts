/**
 * Wilderness supply-drop content (the trade sheet moved to defs/markets).
 * Pure data — the server validates and executes.
 */

/** Wilderness landing points for supply-drop extraction events. */
export const DROP_SITES: [number, number, number][] = [
  [40, 0, 46], // deep forest
  [-45, 0, -44], // quarry floor
  [43, 0, -44], // scrapyard
  [-40, 0, 52], // beyond the surf spine
  [60, 0, 0], // east fields
]

/** Loot rolled into each supply crate (item, min, max). */
export const DROP_LOOT: [string, number, number][] = [
  ['salvage_core', 1, 2],
  ['coin', 4, 9],
  ['scrap_metal', 3, 8],
  ['trail_stew', 1, 2],
]
