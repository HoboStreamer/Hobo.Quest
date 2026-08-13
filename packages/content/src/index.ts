export * from './schema/crop.js'
export * from './schema/npc.js'
export * from './schema/market.js'
export * from './schema/job.js'
export * from './schema/item.js'
export * from './schema/recipe.js'
export * from './schema/skill.js'
export * from './schema/resourceNode.js'
export * from './schema/world.js'
export * from './surface.js'
export * from './mapFileV2.js'
export * from './mapDiff.js'
export * from './registry.js'
export * from './defs/crops.js'
export * from './defs/npcs.js'
export * from './defs/markets.js'
export * from './defs/jobs.js'
export * from './defs/items.js'
export * from './defs/recipes.js'
export * from './defs/skills.js'
export * from './defs/resources.js'
export * from './defs/hoboville.js'

import { ContentRegistry } from './registry.js'
import { HOBOVILLE } from './defs/hoboville.js'
import { CROPS } from './defs/crops.js'
import { FACTIONS, NPC_ARCHETYPES } from './defs/npcs.js'
import { MARKETS } from './defs/markets.js'
import { JOBS } from './defs/jobs.js'
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
    crops: CROPS,
    npcs: NPC_ARCHETYPES,
    factions: FACTIONS,
    markets: MARKETS,
    jobs: JOBS,
    world: HOBOVILLE,
  })
}
export * from './terrain.js'
export * from './defs/economy.js'
export * from './mapFile.js'
