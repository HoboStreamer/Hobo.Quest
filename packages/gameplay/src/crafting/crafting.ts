import type { ContentRegistry, Recipe } from '@hobo/content'
import { err, ok, type Result } from '@hobo/shared'
import type { Inventory } from '../inventory/inventory.js'

/**
 * Crafting validation is pure and server-authoritative. The context describes
 * everything external the recipe may require (nearby workstation kinds now;
 * skills and other conditions later).
 */
export interface CraftContext {
  /** Workstation kinds within interaction range of the player. */
  nearbyWorkstations: ReadonlySet<string>
  /** Player skill levels for recipe gates; absent = no gating (tests/tools). */
  skillLevel?: (skillId: string) => number
}

export type CraftError =
  'unknown_recipe' | 'missing_items' | 'missing_workstation' | 'missing_skill' | 'no_output_space'

export function validateCraft(
  content: ContentRegistry,
  inventory: Inventory,
  recipeId: string,
  ctx: CraftContext,
): Result<Recipe, CraftError> {
  const recipe = content.recipe(recipeId)
  if (!recipe) return err('unknown_recipe')
  if (recipe.workstation && !ctx.nearbyWorkstations.has(recipe.workstation)) {
    return err('missing_workstation')
  }
  if (
    recipe.requiredSkill &&
    ctx.skillLevel &&
    ctx.skillLevel(recipe.requiredSkill.skill) < recipe.requiredSkill.level
  ) {
    return err('missing_skill')
  }
  if (!inventory.canConsume(recipe.inputs)) return err('missing_items')
  // Space check must account for inputs freeing room: simulate on a copy.
  const probe = inventory.clone()
  probe.consume(recipe.inputs)
  for (const out of recipe.outputs) {
    const leftover = probe.add(out.item, out.count)
    if (leftover > 0) return err('no_output_space')
  }
  return ok(recipe)
}
