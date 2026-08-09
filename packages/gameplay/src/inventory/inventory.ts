import type { ContentRegistry } from '@hobo/content'
import { err, ok, type Result } from '@hobo/shared'
import { stacksMergeable, type ItemStack } from '../items/stack.js'

/**
 * Pure inventory domain logic — no UI, no networking, no Babylon. The server
 * owns the authoritative instance per player; the client keeps a replicated
 * copy for display and optimistic UI only.
 *
 * Slot layout: indices [0, hotbarSize) are the hotbar; the rest is backpack.
 */
export interface InventoryDto {
  size: number
  hotbar: number
  slots: { i: number; stack: ItemStack }[]
}

export class Inventory {
  private slots: (ItemStack | null)[]

  constructor(
    readonly size: number,
    readonly hotbarSize: number,
    private readonly content: ContentRegistry,
  ) {
    if (hotbarSize > size) throw new Error('hotbar larger than inventory')
    this.slots = new Array<ItemStack | null>(size).fill(null)
  }

  get(slot: number): ItemStack | null {
    return this.slots[slot] ?? null
  }

  private maxStackOf(defId: string): number {
    return this.content.item(defId)?.maxStack ?? 1
  }

  /**
   * Adds items, filling existing stacks first, then empty slots.
   * Returns the count that did NOT fit.
   */
  add(defId: string, count: number): number {
    const maxStack = this.maxStackOf(defId)
    let remaining = count
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const s = this.slots[i]
      if (s && s.defId === defId && s.meta === undefined && s.count < maxStack) {
        const take = Math.min(maxStack - s.count, remaining)
        s.count += take
        remaining -= take
      }
    }
    for (let i = 0; i < this.size && remaining > 0; i++) {
      if (this.slots[i] === null) {
        const take = Math.min(maxStack, remaining)
        this.slots[i] = { defId, count: take }
        remaining -= take
      }
    }
    return remaining
  }

  /** Total count of an item across all slots. */
  countOf(defId: string): number {
    let total = 0
    for (const s of this.slots) {
      if (s?.defId === defId) total += s.count
    }
    return total
  }

  /** True when every requirement can be consumed. */
  canConsume(requirements: readonly { item: string; count: number }[]): boolean {
    return requirements.every((r) => this.countOf(r.item) >= r.count)
  }

  /**
   * Atomically consumes all requirements or none.
   */
  consume(requirements: readonly { item: string; count: number }[]): Result<void> {
    if (!this.canConsume(requirements)) return err('missing_items')
    for (const r of requirements) {
      let remaining = r.count
      for (let i = 0; i < this.size && remaining > 0; i++) {
        const s = this.slots[i]
        if (s?.defId === r.item) {
          const take = Math.min(s.count, remaining)
          s.count -= take
          remaining -= take
          if (s.count === 0) this.slots[i] = null
        }
      }
    }
    return ok(undefined)
  }

  /** Removes up to `count` from one slot; returns what was removed. */
  removeFromSlot(slot: number, count: number): ItemStack | null {
    const s = this.slots[slot]
    if (!s) return null
    const take = Math.min(s.count, count)
    const removed: ItemStack = { defId: s.defId, count: take, ...(s.meta ? { meta: s.meta } : {}) }
    s.count -= take
    if (s.count === 0) this.slots[slot] = null
    return removed
  }

  /**
   * Moves/merges/swaps between two slots. With `count`, splits that many off
   * the source stack instead (target must be empty or mergeable).
   */
  move(from: number, to: number, count?: number): Result<void> {
    if (from === to) return ok(undefined)
    if (from < 0 || from >= this.size || to < 0 || to >= this.size) return err('bad_slot')
    const src = this.slots[from] ?? null
    if (!src) return err('empty_slot')
    const dst = this.slots[to] ?? null
    const maxStack = this.maxStackOf(src.defId)

    if (count !== undefined) {
      if (count <= 0 || count > src.count) return err('bad_count')
      if (dst === null) {
        this.slots[to] = { defId: src.defId, count, ...(src.meta ? { meta: src.meta } : {}) }
      } else if (stacksMergeable(src, dst) && dst.count + count <= maxStack) {
        dst.count += count
      } else {
        return err('target_occupied')
      }
      src.count -= count
      if (src.count === 0) this.slots[from] = null
      return ok(undefined)
    }

    if (dst === null) {
      this.slots[to] = src
      this.slots[from] = null
    } else if (stacksMergeable(src, dst)) {
      const space = maxStack - dst.count
      const take = Math.min(space, src.count)
      dst.count += take
      src.count -= take
      if (src.count === 0) this.slots[from] = null
    } else {
      this.slots[to] = src
      this.slots[from] = dst
    }
    return ok(undefined)
  }

  /** Space check without mutating: could `count` of `defId` be added? */
  canFit(defId: string, count: number): boolean {
    const maxStack = this.maxStackOf(defId)
    let space = 0
    for (const s of this.slots) {
      if (s === null) space += maxStack
      else if (s.defId === defId && s.meta === undefined) space += maxStack - s.count
      if (space >= count) return true
    }
    return space >= count
  }

  clone(): Inventory {
    return Inventory.fromDto(this.toDto(), this.content)
  }

  toDto(): InventoryDto {
    const slots: InventoryDto['slots'] = []
    for (let i = 0; i < this.size; i++) {
      const s = this.slots[i]
      if (s) slots.push({ i, stack: { ...s } })
    }
    return { size: this.size, hotbar: this.hotbarSize, slots }
  }

  static fromDto(dto: InventoryDto, content: ContentRegistry): Inventory {
    const inv = new Inventory(dto.size, dto.hotbar, content)
    for (const { i, stack } of dto.slots) {
      if (i >= 0 && i < dto.size) inv.slots[i] = { ...stack }
    }
    return inv
  }
}
