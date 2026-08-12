/**
 * The editor's authoring palettes and shared ids.
 *
 * Pure data: what the Mesh and Entity tools can place, which stock textures
 * exist, and how resource nodes are represented in the viewport. Kept out of
 * main.ts so adding a placeable is a data edit, not surgery on boot().
 */
import type { StaticBody } from '@hobo/content'

export type Tool = 'terrain' | 'paint' | 'entity' | 'mesh' | 'select' | 'face' | 'light'

/** Session-stable id generator for map objects (never array positions). */
let idCounter = 0
export const newId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

export interface Placeable {
  name: string
  kind: 'static' | 'node' | 'spawn' | 'model' | 'prop' | 'patch'
  shape?: StaticBody['shape']
  color?: string
  tex?: string
  decor?: string
  node?: string
  modelId?: string
}

/** Mesh tool: primitive shapes the user builds everything from (plus
 *  imported glb models, appended at runtime). No prefab world props —
 *  buildings, ramps and furniture are authored, not picked. */
export const PLACEABLES: Placeable[] = [
  { name: '⬛ Box', kind: 'static', shape: { type: 'box', size: [2, 2, 2] }, color: '#8a8d90' },
  {
    name: '▬ Panel / wall',
    kind: 'static',
    shape: { type: 'box', size: [4, 3, 0.3] },
    color: '#9a9187',
  },
  {
    name: '⚫ Cylinder',
    kind: 'static',
    shape: { type: 'cylinder', radius: 1, height: 2 },
    color: '#8f8a82',
  },
  { name: '🔘 Sphere', kind: 'static', shape: { type: 'sphere', radius: 1 }, color: '#7b7f83' },
  { name: '⛰ Terrain patch (32m sculptable)', kind: 'patch' },
]

/** Entity tool: gameplay spawns — not geometry. */
export const ENTITY_DEFS: Placeable[] = [
  { name: '🚩 Spawn point', kind: 'spawn' },
  { name: '🌳 Oak tree (chop)', kind: 'node', node: 'oak_tree' },
  { name: '🫐 Berry bush', kind: 'node', node: 'berry_bush' },
  { name: '🪨 Stone deposit (pick)', kind: 'node', node: 'stone_deposit' },
  { name: '🌿 Branch pile', kind: 'node', node: 'branch_pile' },
  { name: '🥌 Loose stones', kind: 'node', node: 'loose_stones' },
  { name: '⚙ Scrap pile', kind: 'node', node: 'scrap_pile' },
  { name: '🏪 Merchant stall (shop)', kind: 'prop', node: 'merchant_stall' },
  { name: '📦 Wooden crate (prop)', kind: 'prop', node: 'wooden_crate' },
  { name: '🛢 Metal barrel (prop)', kind: 'prop', node: 'metal_barrel' },
]

export const TEXTURES = [
  '',
  'brown_mud_dry',
  'clay_roof_tiles',
  'floor_pavement',
  'gray_rocks',
  'leafy_grass',
  'metal_plate',
  'plastered_wall_02',
  'red_brick',
  'weathered_plank_siding',
  'wood_planks',
]

/** Visual stand-ins for resource nodes (matched loosely to the game's). */
export const NODE_LOOKS: Record<string, { color: string; shape: StaticBody['shape'] }> = {
  oak_tree: { color: '#4c7a3a', shape: { type: 'cylinder', radius: 1.3, height: 5 } },
  berry_bush: { color: '#3f6a35', shape: { type: 'sphere', radius: 0.7 } },
  stone_deposit: { color: '#7b7f83', shape: { type: 'sphere', radius: 1.1 } },
  branch_pile: { color: '#7a5c38', shape: { type: 'box', size: [1.2, 0.4, 1.2] } },
  loose_stones: { color: '#8a8d90', shape: { type: 'box', size: [1, 0.35, 1] } },
  scrap_pile: { color: '#6d6f72', shape: { type: 'box', size: [1.4, 0.6, 1.4] } },
}
