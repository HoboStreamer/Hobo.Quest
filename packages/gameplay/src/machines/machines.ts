import type { Recipe } from '@hobo/content'
import { containerAdd, type Container, type MaxStackOf } from '../containers/containers.js'

/**
 * Unattended production: a machine prop processes its machine-kind recipes
 * from its own container — inputs sit in the first `inputSlots`, products
 * land in the remaining output slots. Jobs are timestamp-based (doneAt);
 * nothing ticks per frame. The same shape will drive future processors,
 * packagers and underground production lines.
 */

export interface MachineJob {
  recipe: string
  /** Epoch ms when the job finishes. */
  doneAt: number
}

export interface MachineState {
  job?: MachineJob
}

export interface MachineShape {
  inputSlots: number
  outputSlots: number
}

/** Count of an item within the input zone. */
function inputCount(box: Container, shape: MachineShape, defId: string): number {
  let total = 0
  for (let i = 0; i < shape.inputSlots && i < box.length; i++) {
    const s = box[i]
    if (s?.defId === defId) total += s.count
  }
  return total
}

/** Consumes items from the input zone (assumes availability was checked). */
function consumeInputs(
  box: Container,
  shape: MachineShape,
  inputs: readonly { item: string; count: number }[],
): void {
  for (const req of inputs) {
    let left = req.count
    for (let i = 0; i < shape.inputSlots && i < box.length && left > 0; i++) {
      const s = box[i]
      if (s?.defId !== req.item) continue
      const take = Math.min(s.count, left)
      s.count -= take
      left -= take
      if (s.count <= 0) box[i] = null
    }
  }
}

/** Adds outputs into the OUTPUT zone only. Returns true if everything fit. */
function addOutputs(
  box: Container,
  shape: MachineShape,
  outputs: readonly { item: string; count: number }[],
  maxStackOf: MaxStackOf,
): boolean {
  // Work on the output slice, then write back (slot objects are shared but
  // null-assignments are not — hence the copy-back).
  const zone = box.slice(shape.inputSlots)
  let allFit = true
  for (const out of outputs) {
    const leftover = out.count - containerAdd(zone, out.item, out.count, maxStackOf)
    if (leftover > 0) allFit = false
  }
  for (let i = 0; i < zone.length; i++) box[shape.inputSlots + i] = zone[i] ?? null
  return allFit
}

/** Could every output fit in the output zone right now? (No mutation.) */
function outputsFit(
  box: Container,
  shape: MachineShape,
  outputs: readonly { item: string; count: number }[],
  maxStackOf: MaxStackOf,
): boolean {
  const zone = box.slice(shape.inputSlots).map((s) => (s ? { ...s } : null))
  for (const out of outputs) {
    if (containerAdd(zone, out.item, out.count, maxStackOf) < out.count) return false
  }
  return true
}

/**
 * Starts a job if idle: first machine recipe whose inputs are present in
 * the input zone AND whose outputs will fit. Consumes inputs immediately
 * (they are "in the machine"). Returns the started recipe or null.
 */
export function tryStartJob(
  state: MachineState,
  box: Container,
  shape: MachineShape,
  recipes: readonly Recipe[],
  nowMs: number,
): Recipe | null {
  if (state.job) return null
  for (const recipe of recipes) {
    const canConsume = recipe.inputs.every((req) => inputCount(box, shape, req.item) >= req.count)
    if (!canConsume) continue
    consumeInputs(box, shape, recipe.inputs)
    state.job = { recipe: recipe.id, doneAt: nowMs + recipe.craftSeconds * 1000 }
    return recipe
  }
  return null
}

/**
 * Completes a finished job by dropping outputs into the output zone. A
 * full output zone keeps the job parked (retries next sweep — outputs are
 * never destroyed). Returns the completed recipe or null.
 */
export function completeJob(
  state: MachineState,
  box: Container,
  shape: MachineShape,
  recipeOf: (id: string) => Recipe | undefined,
  maxStackOf: MaxStackOf,
  nowMs: number,
): Recipe | null {
  const job = state.job
  if (!job || nowMs < job.doneAt) return null
  const recipe = recipeOf(job.recipe)
  if (!recipe) {
    // Recipe removed from content: the job evaporates (inputs were long
    // consumed; do not fabricate outputs from unknown definitions).
    delete state.job
    return null
  }
  if (!outputsFit(box, shape, recipe.outputs, maxStackOf)) return null
  addOutputs(box, shape, recipe.outputs, maxStackOf)
  delete state.job
  return recipe
}
