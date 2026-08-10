import type { WorldDef } from '../schema/world.js'

/**
 * Hoboville — the persistent world. A walled safe city at the center
 * (spawn, plaza, future shops), gates opening onto the wilds:
 * forest to the NE, quarry to the SW, scrapyard to the SE.
 * City rules: no PvP, no building, no physgun — enforced by the zone
 * system, never by code that knows what a "city" is.
 */

// City square: walls at ±20 with 5m gates centered on each side.
// Wall segments flank each gate: length (40 - 5) / 2 = 17.5.

export const HOBOVILLE: WorldDef = {
  id: 'hoboville_v2',
  flatTerrain: true,
  name: 'Hoboville',
  groundHalfExtent: 80,
  spawnPoint: [0, 1.2, 4],
  spawnYaw: 0,
  // Blank slate: the world ships EMPTY — everything is built with /editor.
  statics: [],

  // Resource nodes are placed with the map editor (MapFile.nodes).
  resourceNodes: [],

  initialProps: [],

  zones: [
    {
      id: 'city',
      name: 'Hoboville',
      min: [-20.5, -1, -20.5],
      max: [20.5, 8, 20.5],
      rules: { pvp: false, build: false, physgun: true },
    },
  ],
}
