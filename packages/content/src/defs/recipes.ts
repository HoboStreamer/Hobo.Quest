import type { Recipe } from '../schema/recipe.js'

export const RECIPES: Recipe[] = [
  // ── Processing ─────────────────────────────────────────────────────
  {
    id: 'buck_logs',
    name: 'Buck Trunk into Logs',
    category: 'processing',
    inputs: [{ item: 'tree_trunk', count: 1 }],
    outputs: [{ item: 'wood_log', count: 6 }],
    craftSeconds: 2,
  },
  {
    id: 'craft_planks',
    name: 'Wood Planks',
    category: 'processing',
    inputs: [{ item: 'wood_log', count: 1 }],
    outputs: [{ item: 'wood_plank', count: 4 }],
    craftSeconds: 1,
  },
  {
    id: 'craft_rope',
    name: 'Rope',
    category: 'processing',
    inputs: [{ item: 'scrap_metal', count: 1 }],
    outputs: [{ item: 'rope', count: 2 }],
    craftSeconds: 1,
  },
  {
    id: 'craft_sheet_metal',
    name: 'Sheet Metal',
    category: 'processing',
    inputs: [{ item: 'scrap_metal', count: 3 }],
    outputs: [{ item: 'sheet_metal', count: 1 }],
    craftSeconds: 2,
    workstation: 'workbench',
  },

  {
    id: 'cook_trail_stew',
    name: 'Trail Stew',
    category: 'food',
    inputs: [
      { item: 'berries', count: 3 },
      { item: 'wood_log', count: 1 },
    ],
    outputs: [{ item: 'trail_stew', count: 1 }],
    craftSeconds: 3,
    workstation: 'campfire',
  },

  // ── Tools ──────────────────────────────────────────────────────────
  {
    id: 'craft_stone_axe',
    name: 'Stone Axe',
    category: 'tools',
    inputs: [
      { item: 'wood_plank', count: 2 },
      { item: 'stone', count: 2 },
    ],
    outputs: [{ item: 'stone_axe', count: 1 }],
    craftSeconds: 3,
  },
  {
    id: 'craft_stone_pickaxe',
    name: 'Stone Pickaxe',
    category: 'tools',
    inputs: [
      { item: 'wood_plank', count: 2 },
      { item: 'stone', count: 3 },
    ],
    outputs: [{ item: 'stone_pickaxe', count: 1 }],
    craftSeconds: 3,
  },
  {
    id: 'craft_rigging_tool',
    name: 'Rigging Tool',
    category: 'tools',
    inputs: [
      { item: 'scrap_metal', count: 2 },
      { item: 'rope', count: 1 },
      { item: 'wood_plank', count: 1 },
    ],
    outputs: [{ item: 'rigging_tool', count: 1 }],
    craftSeconds: 4,
  },
  {
    id: 'craft_salvaged_motor',
    name: 'Salvaged Motor',
    category: 'tools',
    inputs: [
      { item: 'sheet_metal', count: 3 },
      { item: 'scrap_metal', count: 2 },
    ],
    outputs: [{ item: 'salvaged_motor', count: 1 }],
    craftSeconds: 8,
    workstation: 'workbench',
    requiredSkill: { skill: 'construction', level: 4 },
  },

  // ── Construction ───────────────────────────────────────────────────
  {
    id: 'craft_wooden_wall',
    name: 'Wooden Wall',
    category: 'construction',
    inputs: [{ item: 'wood_plank', count: 6 }],
    outputs: [{ item: 'wooden_wall', count: 1 }],
    craftSeconds: 3,
  },
  {
    id: 'craft_wooden_floor',
    name: 'Wooden Floor',
    category: 'construction',
    inputs: [{ item: 'wood_plank', count: 5 }],
    outputs: [{ item: 'wooden_floor', count: 1 }],
    craftSeconds: 3,
  },
  {
    id: 'craft_wooden_beam',
    name: 'Wooden Beam',
    category: 'construction',
    inputs: [{ item: 'wood_plank', count: 2 }],
    outputs: [{ item: 'wooden_beam', count: 1 }],
    craftSeconds: 1,
  },
  {
    id: 'craft_metal_wall',
    name: 'Metal Wall',
    category: 'construction',
    inputs: [
      { item: 'sheet_metal', count: 4 },
      { item: 'wooden_beam', count: 2 },
    ],
    outputs: [{ item: 'metal_wall', count: 1 }],
    craftSeconds: 5,
    workstation: 'workbench',
    requiredSkill: { skill: 'construction', level: 3 },
  },
  {
    id: 'craft_planter_box',
    name: 'Planter Box',
    category: 'farming',
    inputs: [{ item: 'wood_plank', count: 4 }],
    outputs: [{ item: 'planter_box', count: 1 }],
    craftSeconds: 3,
  },
  {
    id: 'extract_seeds',
    name: 'Extract Berry Seeds',
    category: 'farming',
    inputs: [{ item: 'berries', count: 2 }],
    outputs: [{ item: 'berry_seeds', count: 3 }],
    craftSeconds: 1,
  },
  {
    id: 'craft_wooden_door',
    name: 'Wooden Door',
    category: 'construction',
    inputs: [{ item: 'wood_plank', count: 4 }],
    outputs: [{ item: 'wooden_door', count: 1 }],
    craftSeconds: 3,
  },
  {
    id: 'craft_storage_box',
    name: 'Storage Box',
    category: 'construction',
    inputs: [
      { item: 'wood_plank', count: 8 },
      { item: 'rope', count: 1 },
    ],
    outputs: [{ item: 'storage_box', count: 1 }],
    craftSeconds: 4,
  },
  {
    id: 'craft_campfire',
    name: 'Campfire',
    category: 'construction',
    inputs: [
      { item: 'wood_log', count: 3 },
      { item: 'stone', count: 4 },
    ],
    outputs: [{ item: 'campfire', count: 1 }],
    craftSeconds: 2,
  },
  {
    id: 'craft_wooden_crate',
    name: 'Wooden Crate',
    category: 'construction',
    inputs: [
      { item: 'wood_plank', count: 4 },
      { item: 'scrap_metal', count: 2 },
    ],
    outputs: [{ item: 'wooden_crate', count: 1 }],
    craftSeconds: 2,
  },
  {
    id: 'craft_workbench',
    name: 'Workbench',
    category: 'construction',
    inputs: [
      { item: 'wood_plank', count: 8 },
      { item: 'scrap_metal', count: 4 },
      { item: 'rope', count: 2 },
    ],
    outputs: [{ item: 'workbench', count: 1 }],
    craftSeconds: 5,
  },
  {
    id: 'craft_metal_barrel',
    name: 'Metal Barrel',
    category: 'construction',
    inputs: [{ item: 'scrap_metal', count: 6 }],
    outputs: [{ item: 'metal_barrel', count: 1 }],
    craftSeconds: 3,
    workstation: 'workbench',
  },
]

/** Skill credited for crafting a recipe (XP scales with craft time). */
export function recipeSkill(category: Recipe['category']): string {
  return category === 'construction' ? 'construction' : 'crafting'
}

export function recipeXp(recipe: Recipe): number {
  return 5 + Math.round(recipe.craftSeconds * 4)
}
