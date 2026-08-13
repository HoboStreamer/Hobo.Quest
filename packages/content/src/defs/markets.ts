import type { MarketDef } from '../schema/market.js'

/**
 * Market content. Goose's Trading Post replaces the old fixed trade sheet;
 * production chains (lumber, bread, tonic) all cash out here — and the
 * good stuff pays enough to make farming, milling and distilling real
 * businesses.
 */
export const MARKETS: MarketDef[] = [
  {
    id: 'goose_post',
    name: "Goose's Trading Post",
    faction: 'hoboville',
    sells: [
      { item: 'berry_seeds', count: 3, price: 2, stock: 30, restockSeconds: 300 },
      { item: 'mudroot_seeds', count: 3, price: 1, stock: 30, restockSeconds: 300 },
      { item: 'wheat_seeds', count: 4, price: 2, stock: 24, restockSeconds: 300 },
      { item: 'wirevine_seeds', count: 3, price: 2, stock: 18, restockSeconds: 300 },
      { item: 'ember_pepper_seeds', count: 2, price: 8, stock: 6, restockSeconds: 600 },
      { item: 'rope', count: 2, price: 3, stock: 20, restockSeconds: 300 },
      { item: 'stone_axe', count: 1, price: 8, stock: 4, restockSeconds: 600 },
      { item: 'trail_stew', count: 1, price: 5, stock: 10, restockSeconds: 300 },
      { item: 'bandage', count: 2, price: 3, stock: 12, restockSeconds: 300 },
      { item: 'blueprint_still', count: 1, price: 40, stock: 1, restockSeconds: 1800 },
    ],
    buys: [
      { item: 'stone', count: 3, price: 2 },
      { item: 'scrap_metal', count: 5, price: 3 },
      { item: 'wood_log', count: 10, price: 2 },
      { item: 'wood_plank', count: 12, price: 4 },
      { item: 'trail_stew', count: 1, price: 3 },
      { item: 'flatbread', count: 1, price: 4 },
      { item: 'ember_pepper', count: 1, price: 6 },
      { item: 'pepper_tonic', count: 1, price: 18 },
      { item: 'salvage_core', count: 1, price: 25 },
    ],
  },
]
