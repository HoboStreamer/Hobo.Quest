import type { WorldDef } from '../schema/world.js'

/**
 * Hoboville — the persistent world. A walled safe city at the center
 * (spawn, plaza, future shops), gates opening onto the wilds:
 * forest to the NE, quarry to the SW, scrapyard to the SE.
 * City rules: no PvP, no building, no physgun — enforced by the zone
 * system, never by code that knows what a "city" is.
 */

const WALL = '#9a9187'
const BUILDING_A = '#8d7f6d'
const BUILDING_B = '#7d7468'
const PLAZA = '#6e6e72'
const FOUNTAIN = '#5d707e'

// City square: walls at ±20 with 5m gates centered on each side.
// Wall segments flank each gate: length (40 - 5) / 2 = 17.5.
const SEG = 17.5
const OFF = 2.5 + SEG / 2 // segment center offset from gate center

export const HOBOVILLE: WorldDef = {
  id: 'hoboville_v1',
  name: 'Hoboville',
  groundHalfExtent: 80,
  spawnPoint: [0, 1.2, 4],
  spawnYaw: 0,
  statics: [
    // ── Plaza + fountain ────────────────────────────────────────────
    { shape: { type: 'box', size: [26, 0.1, 26] }, pos: [0, 0.05, 0], yaw: 0, color: PLAZA },
    {
      shape: { type: 'cylinder', radius: 1.6, height: 0.9 },
      pos: [0, 0.45, 0],
      yaw: 0,
      color: FOUNTAIN,
    },

    // ── City walls (N wall at z=20, S at z=-20, E at x=20, W at x=-20) ─
    { shape: { type: 'box', size: [SEG, 3.5, 0.6] }, pos: [-OFF, 1.75, 20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [SEG, 3.5, 0.6] }, pos: [OFF, 1.75, 20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [SEG, 3.5, 0.6] }, pos: [-OFF, 1.75, -20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [SEG, 3.5, 0.6] }, pos: [OFF, 1.75, -20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.6, 3.5, SEG] }, pos: [20, 1.75, -OFF], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.6, 3.5, SEG] }, pos: [20, 1.75, OFF], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.6, 3.5, SEG] }, pos: [-20, 1.75, -OFF], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.6, 3.5, SEG] }, pos: [-20, 1.75, OFF], yaw: 0, color: WALL },
    // Gate pillars (visual anchors at each opening)
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [-2.5, 2.1, 20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [2.5, 2.1, 20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [-2.5, 2.1, -20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [2.5, 2.1, -20], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [20, 2.1, -2.5], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [20, 2.1, 2.5], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [-20, 2.1, -2.5], yaw: 0, color: WALL },
    { shape: { type: 'box', size: [0.8, 4.2, 0.8] }, pos: [-20, 2.1, 2.5], yaw: 0, color: WALL },

    // ── City buildings (future shops/services — solid shells for now) ──
    { shape: { type: 'box', size: [6, 4, 5] }, pos: [12, 2, 12], yaw: 0.2, color: BUILDING_A },
    { shape: { type: 'box', size: [5, 4, 6] }, pos: [-12, 2, 12], yaw: -0.15, color: BUILDING_B },
    { shape: { type: 'box', size: [7, 4, 5] }, pos: [-11, 2, -12], yaw: 0.1, color: BUILDING_A },
    { shape: { type: 'box', size: [5, 4, 5] }, pos: [11, 2, -12], yaw: -0.25, color: BUILDING_B },
    // Market awning posts near plaza (small props-to-be; statics for now)
    { shape: { type: 'box', size: [4, 2.2, 2] }, pos: [7, 1.1, -4], yaw: 0.35, color: '#7a6a52' },

    // ── Wilds landmarks ────────────────────────────────────────────
    // Old watchtower on the forest road
    { shape: { type: 'box', size: [2.5, 6, 2.5] }, pos: [30, 3, 30], yaw: 0.4, color: '#6f6a60' },
    // Collapsed shed in the scrapyard
    { shape: { type: 'box', size: [5, 2.2, 4] }, pos: [42, 1.1, -40], yaw: 0.7, color: '#5f5a52' },
    // Quarry ledges
    { shape: { type: 'box', size: [8, 1.2, 6] }, pos: [-42, 0.6, -38], yaw: 0.3, color: '#75716c' },
    { shape: { type: 'box', size: [6, 2.4, 5] }, pos: [-47, 1.2, -43], yaw: 0.5, color: '#6b6762' },
  ],

  resourceNodes: [
    // Forest (NE) — trees need an axe
    { node: 'oak_tree', pos: [34, 0, 38] },
    { node: 'oak_tree', pos: [38, 0, 43] },
    { node: 'oak_tree', pos: [43, 0, 37] },
    { node: 'oak_tree', pos: [47, 0, 44] },
    { node: 'oak_tree', pos: [40, 0, 50] },
    { node: 'oak_tree', pos: [33, 0, 47] },
    { node: 'oak_tree', pos: [50, 0, 38] },
    { node: 'oak_tree', pos: [46, 0, 52] },
    { node: 'oak_tree', pos: [53, 0, 47] },
    { node: 'oak_tree', pos: [36, 0, 55] },
    // Forest edge — hand-gatherable branches (tool bootstrap)
    { node: 'branch_pile', pos: [27, 0, 30] },
    { node: 'branch_pile', pos: [31, 0, 34] },
    { node: 'branch_pile', pos: [25, 0, 36] },

    // Quarry (SW) — deposits need a pickaxe
    { node: 'stone_deposit', pos: [-36, 0, -36] },
    { node: 'stone_deposit', pos: [-41, 0, -41] },
    { node: 'stone_deposit', pos: [-38, 0, -47] },
    { node: 'stone_deposit', pos: [-46, 0, -35] },
    { node: 'stone_deposit', pos: [-51, 0, -46] },
    { node: 'stone_deposit', pos: [-44, 0, -52] },
    { node: 'stone_deposit', pos: [-53, 0, -39] },
    // Quarry edge — loose stones by hand
    { node: 'loose_stones', pos: [-29, 0, -29] },
    { node: 'loose_stones', pos: [-33, 0, -25] },
    { node: 'loose_stones', pos: [-26, 0, -34] },

    // Scrapyard (SE)
    { node: 'scrap_pile', pos: [34, 0, -34] },
    { node: 'scrap_pile', pos: [39, 0, -38] },
    { node: 'scrap_pile', pos: [36, 0, -45] },
    { node: 'scrap_pile', pos: [45, 0, -34] },
    { node: 'scrap_pile', pos: [48, 0, -46] },
    { node: 'scrap_pile', pos: [42, 0, -50] },

    // A little of everything near the west gate for newcomers
    { node: 'branch_pile', pos: [-27, 0, 3] },
    { node: 'loose_stones', pos: [-29, 0, -3] },
    { node: 'scrap_pile', pos: [-32, 0, 6] },
  ],

  initialProps: [
    // Loose props outside the north gate — physgun playground
    { item: 'wooden_crate', pos: [2, 1.0, 25], yaw: 0.3 },
    { item: 'wooden_crate', pos: [2.2, 1.8, 25.1], yaw: 0.9 },
    { item: 'wooden_crate', pos: [-2, 1.0, 27], yaw: 0.1 },
    { item: 'metal_barrel', pos: [-1, 1.0, 24], yaw: 0 },
    { item: 'metal_barrel', pos: [4, 1.0, 27], yaw: 0 },
    // Scrapyard clutter
    { item: 'wooden_crate', pos: [40, 1.0, -42], yaw: 0.6 },
    { item: 'metal_barrel', pos: [44, 1.0, -39], yaw: 0 },
  ],

  zones: [
    {
      id: 'city',
      name: 'Hoboville',
      min: [-20.5, -1, -20.5],
      max: [20.5, 8, 20.5],
      rules: { pvp: false, build: false, physgun: false },
    },
  ],
}
