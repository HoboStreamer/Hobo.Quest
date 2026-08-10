/**
 * NPC economy content: the city merchant's trade sheet and the wilderness
 * supply-drop sites. Pure data — the server validates and executes.
 */

export interface Trade {
  id: string
  /** What the PLAYER pays. */
  give: { item: string; count: number }
  /** What the PLAYER receives. */
  get: { item: string; count: number }
}

export const TRADES: Trade[] = [
  { id: 'sell_stone', give: { item: 'stone', count: 3 }, get: { item: 'coin', count: 2 } },
  { id: 'sell_scrap', give: { item: 'scrap_metal', count: 5 }, get: { item: 'coin', count: 3 } },
  { id: 'sell_stew', give: { item: 'trail_stew', count: 1 }, get: { item: 'coin', count: 3 } },
  { id: 'sell_logs', give: { item: 'wood_log', count: 10 }, get: { item: 'coin', count: 2 } },
  { id: 'sell_core', give: { item: 'salvage_core', count: 1 }, get: { item: 'coin', count: 25 } },
  { id: 'buy_seeds', give: { item: 'coin', count: 2 }, get: { item: 'berry_seeds', count: 3 } },
  { id: 'buy_rope', give: { item: 'coin', count: 3 }, get: { item: 'rope', count: 2 } },
  { id: 'buy_axe', give: { item: 'coin', count: 8 }, get: { item: 'stone_axe', count: 1 } },
  { id: 'buy_stew', give: { item: 'coin', count: 5 }, get: { item: 'trail_stew', count: 1 } },
]

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
