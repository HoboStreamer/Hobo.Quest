import { ItemDefSchema, type ItemDef } from './schema/item.js'
import { RecipeSchema, type Recipe } from './schema/recipe.js'
import { WorldDefSchema, type WorldDef } from './schema/world.js'

/**
 * Immutable, validated content registry built once at startup on both server
 * and client. Fails fast on invalid definitions, duplicate ids, or dangling
 * cross-references (a recipe naming a nonexistent item, etc.) — a content
 * mistake should kill the dev server, not corrupt a live world.
 */
export class ContentRegistry {
  private readonly items = new Map<string, ItemDef>()
  private readonly recipes = new Map<string, Recipe>()
  readonly world: WorldDef

  constructor(items: ItemDef[], recipes: Recipe[], world: WorldDef) {
    const errors: string[] = []

    for (const raw of items) {
      const parsed = ItemDefSchema.safeParse(raw)
      if (!parsed.success) {
        errors.push(`item '${raw.id}': ${parsed.error.message}`)
        continue
      }
      if (this.items.has(parsed.data.id)) errors.push(`duplicate item id '${parsed.data.id}'`)
      this.items.set(parsed.data.id, parsed.data)
    }

    for (const raw of recipes) {
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
      this.recipes.set(recipe.id, recipe)
    }

    const parsedWorld = WorldDefSchema.safeParse(world)
    if (!parsedWorld.success) {
      errors.push(`world '${world.id}': ${parsedWorld.error.message}`)
      this.world = world
    } else {
      this.world = parsedWorld.data
      for (const node of this.world.resourceNodes) {
        if (!this.items.has(node.item)) {
          errors.push(`world resource node references unknown item '${node.item}'`)
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

  allItems(): readonly ItemDef[] {
    return [...this.items.values()]
  }

  allRecipes(): readonly Recipe[] {
    return [...this.recipes.values()]
  }
}
