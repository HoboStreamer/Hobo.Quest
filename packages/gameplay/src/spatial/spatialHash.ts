/**
 * Uniform 2D spatial hash over the ground plane — the one spatial index
 * every proximity consumer shares: replication interest, workstation and
 * shop lookups, sprinkler/power coupling, and (next) NPC perception.
 * Simple and robust beats exotic trees until profiling says otherwise.
 */

const OFFSET = 1 << 15 // world coords are well within ±32k cells

export class SpatialHash<T> {
  private readonly cells = new Map<number, Set<T>>()
  private readonly located = new Map<T, number>()

  constructor(readonly cellSize: number) {}

  private key(x: number, z: number): number {
    const cx = Math.floor(x / this.cellSize) + OFFSET
    const cz = Math.floor(z / this.cellSize) + OFFSET
    return cx * (OFFSET * 2) + cz
  }

  insert(item: T, x: number, z: number): void {
    const key = this.key(x, z)
    this.located.set(item, key)
    let cell = this.cells.get(key)
    if (!cell) {
      cell = new Set()
      this.cells.set(key, cell)
    }
    cell.add(item)
  }

  /** Updates an item's cell; cheap no-op while it stays inside one cell. */
  move(item: T, x: number, z: number): void {
    const key = this.key(x, z)
    const previous = this.located.get(item)
    if (previous === key) return
    if (previous !== undefined) {
      const cell = this.cells.get(previous)
      cell?.delete(item)
      if (cell && cell.size === 0) this.cells.delete(previous)
    }
    this.located.set(item, key)
    let cell = this.cells.get(key)
    if (!cell) {
      cell = new Set()
      this.cells.set(key, cell)
    }
    cell.add(item)
  }

  remove(item: T): void {
    const key = this.located.get(item)
    if (key === undefined) return
    this.located.delete(item)
    const cell = this.cells.get(key)
    cell?.delete(item)
    if (cell && cell.size === 0) this.cells.delete(key)
  }

  has(item: T): boolean {
    return this.located.has(item)
  }

  get size(): number {
    return this.located.size
  }

  /**
   * Visits every item whose CELL intersects the radius. Callers still
   * distance-test exact positions — the hash only prunes candidates.
   */
  forEachInRadius(x: number, z: number, radius: number, visit: (item: T) => void): void {
    const minX = Math.floor((x - radius) / this.cellSize) + OFFSET
    const maxX = Math.floor((x + radius) / this.cellSize) + OFFSET
    const minZ = Math.floor((z - radius) / this.cellSize) + OFFSET
    const maxZ = Math.floor((z + radius) / this.cellSize) + OFFSET
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const cell = this.cells.get(cx * (OFFSET * 2) + cz)
        if (!cell) continue
        for (const item of cell) visit(item)
      }
    }
  }

  /** Radius candidates as an array (convenience for call sites that filter). */
  queryRadius(x: number, z: number, radius: number): T[] {
    const out: T[] = []
    this.forEachInRadius(x, z, radius, (item) => out.push(item))
    return out
  }
}

/**
 * Region tracking: coarse activation cells layered on the same plane.
 * A region is ACTIVE while a player is inside it or one ring away —
 * the seam NPC simulation LOD and event activation hang off. Regions
 * never own persistent data; deactivation must not unload anything.
 */
export class RegionTracker {
  /** Region keys currently active (player ± 1 ring). */
  private active = new Set<number>()
  private playersPerRegion = new Map<number, number>()

  constructor(readonly regionSize: number) {}

  private key(x: number, z: number): number {
    const cx = Math.floor(x / this.regionSize) + OFFSET
    const cz = Math.floor(z / this.regionSize) + OFFSET
    return cx * (OFFSET * 2) + cz
  }

  /** Recomputes activation from player positions (call at low cadence). */
  update(players: Iterable<{ x: number; z: number }>): void {
    this.active = new Set()
    this.playersPerRegion = new Map()
    for (const p of players) {
      const baseKey = this.key(p.x, p.z)
      this.playersPerRegion.set(baseKey, (this.playersPerRegion.get(baseKey) ?? 0) + 1)
      const cx = Math.floor(p.x / this.regionSize) + OFFSET
      const cz = Math.floor(p.z / this.regionSize) + OFFSET
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          this.active.add((cx + dx) * (OFFSET * 2) + (cz + dz))
        }
      }
    }
  }

  /** Is simulation at this position player-relevant right now? */
  isActive(x: number, z: number): boolean {
    return this.active.has(this.key(x, z))
  }

  get activeRegionCount(): number {
    return this.active.size
  }

  get occupiedRegionCount(): number {
    return this.playersPerRegion.size
  }
}
