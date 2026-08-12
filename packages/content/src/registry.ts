import { ItemDefSchema, type ItemDef } from './schema/item.js'
import { RecipeSchema, type Recipe } from './schema/recipe.js'
import { ResourceNodeTypeSchema, type ResourceNodeType } from './schema/resourceNode.js'
import { SkillDefSchema, type SkillDef } from './schema/skill.js'
import { WorldDefSchema, type WorldDef } from './schema/world.js'

export interface ContentDefs {
  items: ItemDef[]
  recipes: Recipe[]
  skills: SkillDef[]
  nodeTypes: ResourceNodeType[]
  world: WorldDef
}

/**
 * Immutable, validated content registry built once at startup on both server
 * and client. Fails fast on invalid definitions, duplicate ids, or dangling
 * cross-references — a content mistake should kill the dev server, not
 * corrupt a live world.
 */
export class ContentRegistry {
  private readonly items = new Map<string, ItemDef>()
  private readonly recipes = new Map<string, Recipe>()
  private readonly skills = new Map<string, SkillDef>()
  private readonly nodeTypes = new Map<string, ResourceNodeType>()
  readonly world: WorldDef

  constructor(defs: ContentDefs) {
    const errors: string[] = []

    for (const raw of defs.items) {
      const parsed = ItemDefSchema.safeParse(raw)
      if (!parsed.success) {
        errors.push(`item '${raw.id}': ${parsed.error.message}`)
        continue
      }
      if (this.items.has(parsed.data.id)) errors.push(`duplicate item id '${parsed.data.id}'`)
      this.items.set(parsed.data.id, parsed.data)
    }

    // Health-capability cross references (after every item is registered).
    for (const item of this.items.values()) {
      if (!item.health) continue
      if (item.health.repair && !this.items.has(item.health.repair.item)) {
        errors.push(`item '${item.id}' repairs with unknown item '${item.health.repair.item}'`)
      }
      for (const loot of item.health.destroyLoot) {
        if (!this.items.has(loot.item)) {
          errors.push(`item '${item.id}' destroy loot references unknown item '${loot.item}'`)
        }
      }
    }

    for (const raw of defs.skills) {
      const parsed = SkillDefSchema.safeParse(raw)
      if (!parsed.success) {
        errors.push(`skill '${raw.id}': ${parsed.error.message}`)
        continue
      }
      if (this.skills.has(parsed.data.id)) errors.push(`duplicate skill id '${parsed.data.id}'`)
      this.skills.set(parsed.data.id, parsed.data)
    }

    for (const raw of defs.nodeTypes) {
      const parsed = ResourceNodeTypeSchema.safeParse(raw)
      if (!parsed.success) {
        errors.push(`node type '${raw.id}': ${parsed.error.message}`)
        continue
      }
      const node = parsed.data
      if (this.nodeTypes.has(node.id)) errors.push(`duplicate node type id '${node.id}'`)
      if (!this.items.has(node.item)) {
        errors.push(`node type '${node.id}' yields unknown item '${node.item}'`)
      }
      if (!this.skills.has(node.skill)) {
        errors.push(`node type '${node.id}' references unknown skill '${node.skill}'`)
      }
      this.nodeTypes.set(node.id, node)
    }

    for (const raw of defs.recipes) {
      const parsed = RecipeSchema.safeParse(raw)
      if (!parsed.success) {
        errors.push(`recipe '${raw.id}': ${parsed.error.message}`)
        continue
      }
      const recipe = parsed.data
      if (this.recipes.has(recipe.id)) errors.push(`duplicate recipe id '${recipe.id}'`)
      for (const ref of [...recipe.inputs, ...recipe.outputs]) {
        if (!this.items.has(ref.item)) {
          errors.push(`recipe '${recipe.id}' references unknown item '${ref.item}'`)
        }
      }
      if (recipe.requiredSkill && !this.skills.has(recipe.requiredSkill.skill)) {
        errors.push(
          `recipe '${recipe.id}' references unknown skill '${recipe.requiredSkill.skill}'`,
        )
      }
      this.recipes.set(recipe.id, recipe)
    }

    const parsedWorld = WorldDefSchema.safeParse(defs.world)
    if (!parsedWorld.success) {
      errors.push(`world '${defs.world.id}': ${parsedWorld.error.message}`)
      this.world = defs.world
    } else {
      this.world = parsedWorld.data
      for (const node of this.world.resourceNodes) {
        if (!this.nodeTypes.has(node.node)) {
          errors.push(`world places unknown resource node type '${node.node}'`)
        }
      }
      for (const prop of this.world.initialProps) {
        const def = this.items.get(prop.item)
        if (!def) errors.push(`world prop references unknown item '${prop.item}'`)
        else if (!def.world) errors.push(`world prop item '${prop.item}' has no world capability`)
      }
    }

    if (errors.length > 0) {
      throw new Error(`Content validation failed:\n  - ${errors.join('\n  - ')}`)
    }
  }

  item(id: string): ItemDef | undefined {
    return this.items.get(id)
  }

  itemOrThrow(id: string): ItemDef {
    const def = this.items.get(id)
    if (!def) throw new Error(`unknown item def '${id}'`)
    return def
  }

  recipe(id: string): Recipe | undefined {
    return this.recipes.get(id)
  }

  skill(id: string): SkillDef | undefined {
    return this.skills.get(id)
  }

  nodeType(id: string): ResourceNodeType | undefined {
    return this.nodeTypes.get(id)
  }

  nodeTypeOrThrow(id: string): ResourceNodeType {
    const def = this.nodeTypes.get(id)
    if (!def) throw new Error(`unknown node type '${id}'`)
    return def
  }

  allItems(): readonly ItemDef[] {
    return [...this.items.values()]
  }

  allRecipes(): readonly Recipe[] {
    return [...this.recipes.values()]
  }

  allSkills(): readonly SkillDef[] {
    return [...this.skills.values()]
  }

  allNodeTypes(): readonly ResourceNodeType[] {
    return [...this.nodeTypes.values()]
  }

  /**
   * Physical representation for ANY item: its authored world capability, or
   * a category-styled fallback so every item can exist in the world (drops,
   * loot). Keeping this in content means "everything is physical" without
   * per-item boilerplate.
   */
  worldRepOf(id: string): NonNullable<ItemDef['world']> {
    const def = this.itemOrThrow(id)
    if (def.world) return def.world
    const color = FALLBACK_COLORS[def.category] ?? '#8a7a5a'
    return {
      shape: { type: 'box', size: [0.28, 0.28, 0.28] },
      massKg: 3,
      color,
      physgun: true,
    }
  }
}

const FALLBACK_COLORS: Record<string, string> = {
  material: '#9a8a6a',
  resource: '#7a8a72',
  component: '#7a8a92',
  tool: '#4a5866',
  food: '#a08a5a',
  seed: '#6a8a5a',
  misc: '#8a8a8a',
}
