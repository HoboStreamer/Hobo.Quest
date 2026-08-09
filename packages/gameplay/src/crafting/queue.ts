import type { ContentRegistry, Recipe } from '@hobo/content'
import { err, ok, type Result } from '@hobo/shared'
import type { Inventory } from '../inventory/inventory.js'
import { validateCraft, type CraftContext, type CraftError } from './crafting.js'

export interface CraftJob {
  recipeId: string
  readyTick: number
}

/**
 * Per-player crafting queue driven by the fixed server tick. Inputs are
 * consumed when the job starts (they are committed); outputs are granted on
 * completion. Timing lives in ticks so crafting is deterministic and
 * replayable — never wall-clock in gameplay logic.
 */
export class CraftQueue {
  private jobs: CraftJob[] = []

  constructor(private readonly maxJobs = 4) {}

  get pending(): readonly CraftJob[] {
    return this.jobs
  }

  start(
    content: ContentRegistry,
    inventory: Inventory,
    recipeId: string,
    ctx: CraftContext,
    currentTick: number,
    tickRate: number,
  ): Result<CraftJob, CraftError | 'queue_full'> {
    if (this.jobs.length >= this.maxJobs) return err('queue_full')
    const validated = validateCraft(content, inventory, recipeId, ctx)
    if (!validated.ok) return validated
    const recipe = validated.value
    inventory.consume(recipe.inputs)
    const job: CraftJob = {
      recipeId: recipe.id,
      readyTick: currentTick + Math.ceil(recipe.craftSeconds * tickRate),
    }
    this.jobs.push(job)
    return ok(job)
  }

  /**
   * Completes due jobs, adding outputs to the inventory. If outputs no longer
   * fit (inventory filled up meanwhile), the job stays queued and retries
   * next tick rather than destroying items.
   */
  update(currentTick: number, content: ContentRegistry, inventory: Inventory): Recipe[] {
    const completed: Recipe[] = []
    this.jobs = this.jobs.filter((job) => {
      if (job.readyTick > currentTick) return true
      const recipe = content.recipe(job.recipeId)
      if (!recipe) return false
      const fitsAll = recipe.outputs.every((o) => inventory.canFit(o.item, o.count))
      if (!fitsAll) return true
      for (const o of recipe.outputs) inventory.add(o.item, o.count)
      completed.push(recipe)
      return false
    })
    return completed
  }
}
