import type { WorldDef } from '../schema/world.js'

/**
 * The vertical-slice test world: a flat yard with a few platforms and ramps
 * for movement testing, scattered resource piles, and some loose props.
 * A tiny "safe pad" zone exercises the zone-rules system.
 */
export const TEST_WORLD: WorldDef = {
  id: 'testyard',
  name: 'Test Yard',
  groundHalfExtent: 60,
  spawnPoint: [0, 1.2, 0],
  spawnYaw: 0,
  statics: [
    // Platforms for step/jump testing
    { shape: { type: 'box', size: [4, 0.4, 4] }, pos: [6, 0.2, 6], yaw: 0, color: '#8a8f98' },
    { shape: { type: 'box', size: [4, 0.8, 4] }, pos: [10, 0.4, 6], yaw: 0, color: '#7d828b' },
    { shape: { type: 'box', size: [4, 1.2, 4] }, pos: [14, 0.6, 6], yaw: 0, color: '#70757e' },
    // A wall
    { shape: { type: 'box', size: [8, 3, 0.4] }, pos: [-8, 1.5, -6], yaw: 0.5, color: '#9a9187' },
    // Safe pad marker slab
    { shape: { type: 'box', size: [8, 0.1, 8] }, pos: [-12, 0.05, 10], yaw: 0, color: '#4a6b52' },
  ],
  resourceNodes: [
    { item: 'wood_plank', pos: [4, 0.4, -5], amount: 24, perUse: 2 },
    { item: 'wood_plank', pos: [-3, 0.4, -9], amount: 24, perUse: 2 },
    { item: 'scrap_metal', pos: [9, 0.4, -3], amount: 20, perUse: 2 },
    { item: 'scrap_metal', pos: [-7, 0.4, 3], amount: 20, perUse: 2 },
  ],
  initialProps: [
    { item: 'wooden_crate', pos: [2, 1.5, 3], yaw: 0.3 },
    { item: 'wooden_crate', pos: [2.2, 2.5, 3.1], yaw: 0.9 },
    { item: 'metal_barrel', pos: [-2, 1.5, 4], yaw: 0 },
    { item: 'metal_barrel', pos: [-2.8, 1.5, 4.2], yaw: 0 },
  ],
  zones: [
    {
      id: 'safe_pad',
      name: 'Safe Pad',
      min: [-16, -1, 6],
      max: [-8, 6, 14],
      rules: { pvp: false, build: true, physgun: true },
    },
  ],
}
