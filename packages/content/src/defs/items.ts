import type { ItemDef } from '../schema/item.js'

/**
 * Item content. Tools carry a `tool` capability (what primary fire does),
 * building pieces carry `world` + `placeable`, stations add `workstation`.
 * Adding an item must never require engine changes.
 */
export const ITEMS: ItemDef[] = [
  // ── Tools ──────────────────────────────────────────────────────────
  {
    id: 'physgun',
    name: 'Physgun',
    description: 'Field manipulator. Grab, drag, rotate, freeze. The sandbox in your hands.',
    category: 'tool',
    maxStack: 1,
    tool: { kind: 'physgun', power: 1, range: 8 },
  },
  {
    id: 'stone_axe',
    name: 'Stone Axe',
    description: 'Fells trees. Crude, heavy, effective.',
    category: 'tool',
    maxStack: 1,
    tool: { kind: 'axe', power: 2, range: 3.5 },
  },
  {
    id: 'stone_pickaxe',
    name: 'Stone Pickaxe',
    description: 'Breaks stone deposits apart.',
    category: 'tool',
    maxStack: 1,
    tool: { kind: 'pickaxe', power: 2, range: 3.5 },
  },

  // ── Materials ──────────────────────────────────────────────────────
  {
    id: 'wood_log',
    name: 'Wood Log',
    description: 'Raw timber. Saw into planks.',
    category: 'material',
    maxStack: 20,
    world: {
      shape: { type: 'cylinder', radius: 0.14, height: 0.6 },
      massKg: 5,
      color: '#7a5432',
      physgun: true,
    },
  },
  {
    id: 'tree_trunk',
    name: 'Tree Trunk',
    description: 'A whole felled trunk. Buck it into logs.',
    category: 'material',
    maxStack: 1,
    world: {
      shape: { type: 'cylinder', radius: 0.3, height: 2.9 },
      massKg: 70,
      color: '#6d4c2a',
      physgun: true,
    },
  },
  {
    id: 'wood_plank',
    name: 'Wood Plank',
    description: 'Rough-sawn lumber, good enough to build with.',
    category: 'material',
    maxStack: 50,
    world: {
      shape: { type: 'box', size: [0.9, 0.07, 0.28] },
      massKg: 3,
      color: '#a3814e',
      physgun: true,
    },
  },
  {
    id: 'stone',
    name: 'Stone',
    description: 'Quarried rock. Heavy and dependable.',
    category: 'material',
    maxStack: 50,
    world: {
      shape: { type: 'sphere', radius: 0.17 },
      massKg: 6,
      color: '#83878b',
      physgun: true,
    },
  },
  {
    id: 'scrap_metal',
    name: 'Scrap Metal',
    description: 'Twisted bits of salvage. The wilderness provides.',
    category: 'material',
    maxStack: 50,
    world: {
      shape: { type: 'box', size: [0.42, 0.12, 0.3] },
      massKg: 4,
      color: '#6a7076',
      physgun: true,
    },
  },
  {
    id: 'sheet_metal',
    name: 'Sheet Metal',
    description: 'Scrap hammered flat at a workbench.',
    category: 'material',
    maxStack: 20,
  },
  {
    id: 'rope',
    name: 'Rope',
    description: 'Braided scavenged fiber.',
    category: 'component',
    maxStack: 20,
  },

  // ── Building pieces (crafted physical objects, physgun-placed) ─────
  {
    id: 'wooden_wall',
    name: 'Wooden Wall',
    description: 'A solid timber wall section. Freeze it in place.',
    category: 'building',
    maxStack: 10,
    world: {
      shape: { type: 'box', size: [2, 2.4, 0.15] },
      massKg: 40,
      color: '#8a6238',
      physgun: true,
    },
    placeable: { maxRange: 4, snapStep: 0.5 },
  },
  {
    id: 'wooden_floor',
    name: 'Wooden Floor',
    description: 'A timber floor/roof panel.',
    category: 'building',
    maxStack: 10,
    world: {
      shape: { type: 'box', size: [2, 0.12, 2] },
      massKg: 30,
      color: '#96703f',
      physgun: true,
    },
    placeable: { maxRange: 4, snapStep: 0.5 },
  },
  {
    id: 'wooden_beam',
    name: 'Wooden Beam',
    description: 'Framing timber for ad-hoc engineering.',
    category: 'building',
    maxStack: 20,
    world: {
      shape: { type: 'box', size: [0.15, 0.15, 2.4] },
      massKg: 12,
      color: '#7a5631',
      physgun: true,
    },
    placeable: { maxRange: 4, snapStep: 0.25 },
  },
  {
    id: 'metal_wall',
    name: 'Metal Wall',
    description: 'Sheet-metal wall section. Serious protection.',
    category: 'building',
    maxStack: 10,
    world: {
      shape: { type: 'box', size: [2, 2.4, 0.12] },
      massKg: 70,
      color: '#67737c',
      physgun: true,
    },
    placeable: { maxRange: 4, snapStep: 0.5 },
  },
  {
    id: 'storage_box',
    name: 'Storage Box',
    description: 'A lidded box for stashing goods. (Container storage soon.)',
    category: 'building',
    maxStack: 4,
    world: {
      shape: { type: 'box', size: [0.9, 0.8, 0.6] },
      massKg: 30,
      color: '#6d5a3e',
      physgun: true,
    },
    placeable: { maxRange: 3.5, snapStep: 0.35 },
  },
  {
    id: 'campfire',
    name: 'Campfire',
    description: 'Stone ring and kindling. Warmth and cooking, eventually.',
    category: 'building',
    maxStack: 2,
    world: {
      shape: { type: 'cylinder', radius: 0.4, height: 0.3 },
      massKg: 15,
      color: '#8c4f2f',
      physgun: true,
    },
    placeable: { maxRange: 3.5, snapStep: 0 },
  },

  // ── Props / stations ───────────────────────────────────────────────
  {
    id: 'wooden_crate',
    name: 'Wooden Crate',
    description: 'A sturdy crate. Stack it, hide behind it, build with it.',
    category: 'placeable',
    maxStack: 4,
    world: {
      shape: { type: 'box', size: [0.7, 0.7, 0.7] },
      massKg: 25,
      color: '#a5713a',
      physgun: true,
    },
    placeable: { maxRange: 3.5, snapStep: 0.35 },
  },
  {
    id: 'metal_barrel',
    name: 'Metal Barrel',
    description: 'Dented but serviceable.',
    category: 'placeable',
    maxStack: 2,
    world: {
      shape: { type: 'cylinder', radius: 0.3, height: 0.9 },
      massKg: 35,
      color: '#5b6b73',
      physgun: true,
    },
    placeable: { maxRange: 3.5, snapStep: 0 },
  },
  {
    id: 'workbench',
    name: 'Workbench',
    description: 'A flat surface and a vice. Unlocks serious crafting.',
    category: 'placeable',
    maxStack: 1,
    world: {
      shape: { type: 'box', size: [1.2, 0.9, 0.7] },
      massKg: 60,
      color: '#7a5c3e',
      physgun: true,
    },
    placeable: { maxRange: 3.5, snapStep: 0 },
    workstation: { kind: 'workbench', range: 3 },
  },
]

/** Items granted once to every new (or migrated) player. */
export const STARTER_ITEMS: readonly { item: string; count: number }[] = [
  { item: 'physgun', count: 1 },
]
