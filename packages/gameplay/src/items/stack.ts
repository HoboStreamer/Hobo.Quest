/** A stack of one item kind. `meta` is per-stack data (durability, quality...). */
export interface ItemStack {
  defId: string
  count: number
  meta?: Record<string, number | string>
}

/** Stacks merge only when the def matches and neither carries metadata. */
export function stacksMergeable(a: ItemStack, b: ItemStack): boolean {
  return a.defId === b.defId && a.meta === undefined && b.meta === undefined
}
