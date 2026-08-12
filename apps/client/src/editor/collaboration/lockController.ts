/**
 * Client half of the editing locks. The SERVER arbitrates — this only asks,
 * tracks what it was granted, and makes the answer visible.
 *
 * The rules that matter:
 *  - Hovering never acquires anything. Locks follow intent to EDIT, not
 *    attention, or moving the mouse across a busy map would lock it solid.
 *  - A group edit is ALL OR NOTHING. A transform that could only move half
 *    its members is worse than one that does not start.
 *  - Read-only selection of a locked object is fine; mutation is refused.
 *  - Losing a lease mid-gesture cancels the gesture back to its exact start,
 *    rather than leaving half-applied local state the server disagrees with.
 */
export type LockState = 'unlocked' | 'pending' | 'owned' | 'denied' | 'lost'

export interface LockOwner {
  peerId: number
  name: string
  color: string
}

export interface LockTransport {
  /** Ask the server for these ids, atomically. */
  request: (ids: readonly string[]) => void
  release: (ids: readonly string[]) => void
}

export interface LockControllerEvents {
  /** Granted: the pending gesture may proceed. */
  onGranted?: (ids: readonly string[]) => void
  onDenied?: (owner: string) => void
  /** The lease went away mid-gesture; roll back. */
  onLost?: () => void
  onChange?: () => void
}

export class LockController {
  private state: LockState = 'unlocked'
  private held: string[] = []
  private pending: { ids: string[]; then?: () => void } | null = null
  /** object id → who holds it, from the server's authoritative broadcast. */
  private owners = new Map<string, LockOwner>()
  private myPeerId = -1

  constructor(
    private readonly transport: LockTransport,
    private readonly events: LockControllerEvents = {},
  ) {}

  setPeerId(id: number): void {
    this.myPeerId = id
  }

  get current(): LockState {
    return this.state
  }

  get heldIds(): readonly string[] {
    return this.held
  }

  /** Who holds `id`, if anyone else does. */
  ownerOf(id: string): LockOwner | null {
    const owner = this.owners.get(id)
    return owner && owner.peerId !== this.myPeerId ? owner : null
  }

  /** Every object someone else is editing, for the Outliner and visuals. */
  remoteLocks(): Map<string, LockOwner> {
    const out = new Map<string, LockOwner>()
    for (const [id, owner] of this.owners) if (owner.peerId !== this.myPeerId) out.set(id, owner)
    return out
  }

  /**
   * Do WE hold this lock?
   *
   * Deliberately not the same question as "is it free". Treating "nobody
   * else has it" as permission to mutate is how a server-authoritative lock
   * system ends up never being acquired at all: both editors decide they may
   * proceed and the arbitration never runs.
   */
  owns(id: string): boolean {
    return this.state === 'owned' && this.held.includes(id)
  }

  /** All of them, or none: a partial group transform is not offered. */
  ownsAll(ids: readonly string[]): boolean {
    return ids.length === 0 || (this.state === 'owned' && ids.every((id) => this.held.includes(id)))
  }

  /** Free as far as the server's last broadcast says. NOT authorization. */
  isFree(id: string): boolean {
    return this.ownerOf(id) === null
  }

  /**
   * Ask to edit `ids`. Returns true when the locks are already held, in
   * which case the caller may proceed immediately; otherwise `then` runs on
   * the grant.
   */
  acquire(ids: readonly string[], then?: () => void): boolean {
    if (ids.length === 0) return true
    if (this.ownsAll(ids)) return true
    const blocked = ids.find((id) => !this.isFree(id))
    if (blocked !== undefined) {
      this.state = 'denied'
      this.events.onDenied?.(this.ownerOf(blocked)!.name)
      this.events.onChange?.()
      return false
    }
    this.state = 'pending'
    this.pending = { ids: [...ids], ...(then ? { then } : {}) }
    this.transport.request(ids)
    this.events.onChange?.()
    return false
  }

  /** Server said yes. */
  granted(ids: readonly string[]): void {
    this.held = [...ids]
    this.state = 'owned'
    const pending = this.pending
    this.pending = null
    this.events.onGranted?.(this.held)
    pending?.then?.()
    this.events.onChange?.()
  }

  /** Server said no. Nothing local has been mutated at this point. */
  denied(owner: string): void {
    this.pending = null
    this.state = 'denied'
    this.events.onDenied?.(owner)
    this.events.onChange?.()
  }

  /**
   * The server's authoritative lock table. This is also where a LOST lease
   * is detected: we believe we hold ids the server no longer attributes to
   * us (expiry, a reconnect race), so whatever is mid-gesture must roll back.
   */
  setOwners(owners: ReadonlyMap<string, LockOwner>): void {
    this.owners = new Map(owners)
    if (this.state === 'owned') {
      const lost = this.held.some((id) => this.owners.get(id)?.peerId !== this.myPeerId)
      if (lost) {
        this.state = 'lost'
        this.held = []
        this.events.onLost?.()
      }
    }
    this.events.onChange?.()
  }

  /**
   * Give back just these. Used when a selection shrinks: keeping a lock on
   * something you deselected blocks a collaborator for no reason.
   */
  release(ids: readonly string[]): void {
    const mine = ids.filter((id) => this.held.includes(id))
    if (mine.length === 0) return
    this.transport.release(mine)
    this.held = this.held.filter((id) => !mine.includes(id))
    if (this.held.length === 0) this.state = 'unlocked'
    this.events.onChange?.()
  }

  /** Deselect everything, cancel, reload: give them all back. */
  releaseAll(): void {
    if (this.held.length > 0) this.transport.release(this.held)
    this.held = []
    this.pending = null
    this.state = 'unlocked'
    this.events.onChange?.()
  }

  /** Connection dropped: the server will expire the leases; forget locally. */
  disconnected(): void {
    this.held = []
    this.pending = null
    this.owners.clear()
    this.state = 'unlocked'
    this.events.onChange?.()
  }
}
