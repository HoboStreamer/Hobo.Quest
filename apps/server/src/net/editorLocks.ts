/**
 * Server-authoritative transient edit locks for the collaborative map
 * editor. Locks are leases: they expire unless the owner's connection
 * keeps heartbeating, and they never serialize into the map. Pure class —
 * unit tested; the WebSocket layer wires it to peers.
 */

export interface LockResult {
  granted: boolean
  /** On denial: the object ids that were already held by someone else. */
  blocked: { id: string; owner: number }[]
}

const LEASE_MS = 45_000

export class LockManager {
  /** object id -> owning peer id */
  private readonly locks = new Map<string, number>()
  /** peer id -> last heartbeat ms */
  private readonly beats = new Map<number, number>()

  /**
   * Atomically acquire ALL ids for a peer (all-or-nothing): a multi-select
   * transform must never start with half its objects locked.
   */
  acquire(peer: number, ids: string[], now: number): LockResult {
    this.beats.set(peer, now)
    const blocked: { id: string; owner: number }[] = []
    for (const id of ids) {
      const owner = this.locks.get(id)
      if (owner !== undefined && owner !== peer) blocked.push({ id, owner })
    }
    if (blocked.length > 0) return { granted: false, blocked }
    for (const id of ids) this.locks.set(id, peer)
    return { granted: true, blocked: [] }
  }

  release(peer: number, ids: string[]): void {
    for (const id of ids) {
      if (this.locks.get(id) === peer) this.locks.delete(id)
    }
  }

  releaseAll(peer: number): string[] {
    const freed: string[] = []
    for (const [id, owner] of this.locks) {
      if (owner === peer) {
        this.locks.delete(id)
        freed.push(id)
      }
    }
    this.beats.delete(peer)
    return freed
  }

  heartbeat(peer: number, now: number): void {
    this.beats.set(peer, now)
  }

  /** Expire leases of peers that stopped heartbeating; returns freed ids. */
  sweep(now: number): string[] {
    const freed: string[] = []
    for (const [peer, at] of this.beats) {
      if (now - at > LEASE_MS) {
        freed.push(...this.releaseAll(peer))
      }
    }
    return freed
  }

  ownerOf(id: string): number | undefined {
    return this.locks.get(id)
  }

  /** Full lock state for broadcasting: id -> owner peer id. */
  state(): Record<string, number> {
    return Object.fromEntries(this.locks)
  }
}
