/**
 * Server-authoritative transient edit locks for the collaborative map
 * editor. Locks are leases: they expire unless the owner's connection
 * keeps heartbeating, and they never serialize into the map. Pure class —
 * unit tested; the WebSocket layer wires it to peers.
 */
export interface LockResult {
  granted: boolean
  /** On denial: the object ids that were already held by someone else. */
  blocked: {
    id: string
    owner: number
  }[]
}
export declare class LockManager {
  /** object id -> owning peer id */
  private readonly locks
  /** peer id -> last heartbeat ms */
  private readonly beats
  /**
   * Atomically acquire ALL ids for a peer (all-or-nothing): a multi-select
   * transform must never start with half its objects locked.
   */
  acquire(peer: number, ids: string[], now: number): LockResult
  release(peer: number, ids: string[]): void
  releaseAll(peer: number): string[]
  heartbeat(peer: number, now: number): void
  /** Expire leases of peers that stopped heartbeating; returns freed ids. */
  sweep(now: number): string[]
  ownerOf(id: string): number | undefined
  /** Full lock state for broadcasting: id -> owner peer id. */
  state(): Record<string, number>
}
//# sourceMappingURL=editorLocks.d.ts.map
