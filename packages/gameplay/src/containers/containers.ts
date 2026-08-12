/**
 * Container domain: the slot-array item storage used by every physical
 * thing that holds items — storage boxes, supply crates, and later machine
 * inputs/outputs, vehicle trunks and merchant stock. One representation,
 * one rule set; systems never invent their own storage shape.
 *
 * A container is `({defId, count} | null)[]` — the same shape PropComponent
 * persists. Pure functions; the caller supplies max-stack lookups so this
 * stays content-agnostic.
 */

export type ContainerSlot = { defId: string; count: number } | null
export type Container = ContainerSlot[]

export type MaxStackOf = (defId: string) => number

/** Adds with stacking (existing stacks first). Returns how many fit. */
export function containerAdd(
  box: Container,
  defId: string,
  count: number,
  maxStackOf: MaxStackOf,
): number {
  const maxStack = maxStackOf(defId)
  let left = count
  for (const slot of box) {
    if (left <= 0) break
    if (slot && slot.defId === defId && slot.count < maxStack) {
      const take = Math.min(maxStack - slot.count, left)
      slot.count += take
      left -= take
    }
  }
  for (let i = 0; i < box.length && left > 0; i++) {
    if (!box[i]) {
      const take = Math.min(maxStack, left)
      box[i] = { defId, count: take }
      left -= take
    }
  }
  return count - left
}

/** Removes up to `count` from a slot; returns what actually came out. */
export function containerTake(
  box: Container,
  slot: number,
  count: number,
): { defId: string; count: number } | null {
  const s = box[slot]
  if (!s) return null
  const take = Math.min(s.count, count)
  s.count -= take
  if (s.count <= 0) box[slot] = null
  return { defId: s.defId, count: take }
}

/** Total of one item across all slots. */
export function containerCount(box: Container, defId: string): number {
  let total = 0
  for (const s of box) if (s?.defId === defId) total += s.count
  return total
}

/** True when `count` of `defId` would fit. */
export function containerCanFit(
  box: Container,
  defId: string,
  count: number,
  maxStackOf: MaxStackOf,
): boolean {
  const maxStack = maxStackOf(defId)
  let space = 0
  for (const s of box) {
    if (s === null) space += maxStack
    else if (s.defId === defId) space += maxStack - s.count
    if (space >= count) return true
  }
  return space >= count
}

/**
 * Moves/merges/swaps between two slots of the SAME container. With
 * `count`, splits that many off instead (target empty or same item).
 */
export function containerMove(
  box: Container,
  from: number,
  to: number,
  maxStackOf: MaxStackOf,
  count?: number,
): boolean {
  if (from === to) return true
  if (from < 0 || from >= box.length || to < 0 || to >= box.length) return false
  const src = box[from]
  if (!src) return false
  const dst = box[to] ?? null
  const maxStack = maxStackOf(src.defId)
  if (count !== undefined) {
    if (count <= 0 || count > src.count) return false
    if (dst === null) {
      box[to] = { defId: src.defId, count }
    } else if (dst.defId === src.defId && dst.count + count <= maxStack) {
      dst.count += count
    } else {
      return false
    }
    src.count -= count
    if (src.count <= 0) box[from] = null
    return true
  }
  if (dst === null) {
    box[to] = src
    box[from] = null
  } else if (dst.defId === src.defId) {
    const take = Math.min(maxStack - dst.count, src.count)
    if (take <= 0) {
      box[to] = src
      box[from] = dst
      return true
    }
    dst.count += take
    src.count -= take
    if (src.count <= 0) box[from] = null
  } else {
    box[to] = src
    box[from] = dst
  }
  return true
}

/**
 * Compacts and sorts: merges partial stacks, orders by item id, leaves
 * trailing slots empty. Stable and loss-free by construction.
 */
export function containerSort(box: Container, maxStackOf: MaxStackOf): void {
  const totals = new Map<string, number>()
  for (const s of box) {
    if (s) totals.set(s.defId, (totals.get(s.defId) ?? 0) + s.count)
  }
  const ids = [...totals.keys()].sort()
  let i = 0
  for (const defId of ids) {
    const maxStack = maxStackOf(defId)
    let left = totals.get(defId)!
    while (left > 0 && i < box.length) {
      const take = Math.min(maxStack, left)
      box[i] = { defId, count: take }
      left -= take
      i++
    }
  }
  for (; i < box.length; i++) box[i] = null
}

/**
 * Container-to-container transfer of one slot's stack (as much as fits).
 * Returns how many items moved. Works for player→box, box→machine, etc.
 * when both sides use the container shape.
 */
export function containerTransfer(
  from: Container,
  fromSlot: number,
  to: Container,
  maxStackOf: MaxStackOf,
  count?: number,
): number {
  const src = from[fromSlot]
  if (!src) return 0
  const want = count === undefined ? src.count : Math.min(count, src.count)
  if (want <= 0) return 0
  const probe = Math.min(want, src.count)
  const moved = containerAdd(to, src.defId, probe, maxStackOf)
  if (moved > 0) {
    src.count -= moved
    if (src.count <= 0) from[fromSlot] = null
  }
  return moved
}
