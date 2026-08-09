import type { Recipe } from '../schema/recipe.js'

export const RECIPES: Recipe[] = [
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
    id: 'craft_rope',
    name: 'Rope',
    category: 'processing',
    inputs: [{ item: 'scrap_metal', count: 1 }],
    outputs: [{ item: 'rope', count: 2 }],
    craftSeconds: 1,
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
