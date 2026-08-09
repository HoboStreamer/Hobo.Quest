import type { ItemDef } from '../schema/item.js'

/**
 * Vertical-slice item set. Content lives in data files like this one (soon:
 * JSON/YAML loaded from disk) — adding an item must never require engine
 * changes.
 */
export const ITEMS: ItemDef[] = [
  {
    id: 'scrap_metal',
    name: 'Scrap Metal',
    description: 'Twisted bits of salvage. The wilderness provides.',
    category: 'material',
    maxStack: 50,
  },
  {
    id: 'wood_plank',
    name: 'Wood Plank',
    description: 'Rough-sawn lumber, good enough to build with.',
    category: 'material',
    maxStack: 50,
  },
  {
    id: 'rope',
    name: 'Rope',
    description: 'Braided scavenged fiber.',
    category: 'component',
    maxStack: 20,
  },
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
