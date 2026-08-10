export * from './schema/item.js'
export * from './schema/recipe.js'
export * from './schema/skill.js'
export * from './schema/resourceNode.js'
export * from './schema/world.js'
export * from './registry.js'
export * from './defs/items.js'
export * from './defs/recipes.js'
export * from './defs/skills.js'
export * from './defs/resources.js'
export * from './defs/hoboville.js'

import { ContentRegistry } from './registry.js'
import { HOBOVILLE } from './defs/hoboville.js'
import { ITEMS } from './defs/items.js'
import { RECIPES } from './defs/recipes.js'
import { RESOURCE_NODES } from './defs/resources.js'
import { SKILLS } from './defs/skills.js'

/** The game's full validated content set (server and client build the same one). */
export function createContent(): ContentRegistry {
  return new ContentRegistry({
    items: ITEMS,
    recipes: RECIPES,
    skills: SKILLS,
    nodeTypes: RESOURCE_NODES,
    world: HOBOVILLE,
  })
}
export * from './terrain.js'
export * from './defs/economy.js'
