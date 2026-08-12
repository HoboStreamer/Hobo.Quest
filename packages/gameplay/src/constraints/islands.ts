/**
 * Connected-constraint island tracking. A constrained structure behaves as
 * one object for settle/wake policy, metrics, and (later) machine/vehicle
 * assembly recognition, so the server needs cheap "who is connected to
 * whom" queries over the constraint graph.
 *
 * Union-find over edges, rebuilt lazily after removals (removal breaks
 * incremental union-find; constraint counts are small — hundreds — so a
 * full rebuild is a trivial cost paid only when something was cut).
 */

export interface ConstraintEdge<TNode> {
  id: string
  a: TNode
  b: TNode
}

export class ConstraintIslands<TNode> {
  private readonly edges = new Map<string, ConstraintEdge<TNode>>()
  private parent = new Map<TNode, TNode>()
  private dirty = false

  addEdge(id: string, a: TNode, b: TNode): void {
    this.edges.set(id, { id, a, b })
    if (!this.dirty) {
      // Incremental union while the structure only grows.
      this.union(a, b)
    }
  }

  removeEdge(id: string): void {
    if (this.edges.delete(id)) this.dirty = true
  }

  /** Removes every edge touching the node (entity despawn). */
  removeNode(node: TNode): string[] {
    const removed: string[] = []
    for (const edge of this.edges.values()) {
      if (edge.a === node || edge.b === node) removed.push(edge.id)
    }
    for (const id of removed) this.edges.delete(id)
    if (removed.length > 0) this.dirty = true
    return removed
  }

  get edgeCount(): number {
    return this.edges.size
  }

  /** Nodes transitively connected to `node` (including itself), or just
   * itself when unconstrained. */
  islandOf(node: TNode): Set<TNode> {
    this.rebuildIfDirty()
    const root = this.find(node)
    const island = new Set<TNode>([node])
    if (root === undefined) return island
    for (const other of this.parent.keys()) {
      if (this.find(other) === root) island.add(other)
    }
    return island
  }

  /** True when the two nodes are in the same constrained structure. */
  connected(a: TNode, b: TNode): boolean {
    this.rebuildIfDirty()
    const ra = this.find(a)
    const rb = this.find(b)
    return ra !== undefined && ra === rb
  }

  /** Number of distinct multi-body islands (size >= 2). */
  islandCount(): number {
    this.rebuildIfDirty()
    const roots = new Set<TNode>()
    for (const node of this.parent.keys()) roots.add(this.find(node)!)
    return roots.size
  }

  /** All islands as node sets (size >= 2 — solitary props are not islands). */
  allIslands(): Set<TNode>[] {
    this.rebuildIfDirty()
    const byRoot = new Map<TNode, Set<TNode>>()
    for (const node of this.parent.keys()) {
      const root = this.find(node)!
      let set = byRoot.get(root)
      if (!set) {
        set = new Set()
        byRoot.set(root, set)
      }
      set.add(node)
    }
    return [...byRoot.values()]
  }

  private rebuildIfDirty(): void {
    if (!this.dirty) return
    this.parent = new Map()
    for (const edge of this.edges.values()) this.union(edge.a, edge.b)
    this.dirty = false
  }

  private find(node: TNode): TNode | undefined {
    let current: TNode | undefined = this.parent.get(node)
    if (current === undefined) return undefined
    // Path halving.
    while (current !== this.parent.get(current)) {
      const parent: TNode = this.parent.get(current) as TNode
      const grand: TNode = this.parent.get(parent) as TNode
      this.parent.set(current, grand)
      current = grand
    }
    return current
  }

  private union(a: TNode, b: TNode): void {
    if (!this.parent.has(a)) this.parent.set(a, a)
    if (!this.parent.has(b)) this.parent.set(b, b)
    const ra = this.find(a)!
    const rb = this.find(b)!
    if (ra !== rb) this.parent.set(ra, rb)
  }
}
