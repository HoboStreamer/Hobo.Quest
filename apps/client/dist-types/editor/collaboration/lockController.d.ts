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
export type LockState = 'unlocked' | 'pending' | 'owned' | 'denied' | 'lost';
export interface LockOwner {
    peerId: number;
    name: string;
    color: string;
}
export interface LockTransport {
    /** Ask the server for these ids, atomically. */
    request: (ids: readonly string[]) => void;
    release: (ids: readonly string[]) => void;
}
export interface LockControllerEvents {
    /** Granted: the pending gesture may proceed. */
    onGranted?: (ids: readonly string[]) => void;
    onDenied?: (owner: string) => void;
    /** The lease went away mid-gesture; roll back. */
    onLost?: () => void;
    onChange?: () => void;
}
export declare class LockController {
    private readonly transport;
    private readonly events;
    private state;
    private held;
    private pending;
    /** object id → who holds it, from the server's authoritative broadcast. */
    private owners;
    private myPeerId;
    constructor(transport: LockTransport, events?: LockControllerEvents);
    setPeerId(id: number): void;
    get current(): LockState;
    get heldIds(): readonly string[];
    /** Who holds `id`, if anyone else does. */
    ownerOf(id: string): LockOwner | null;
    /** Every object someone else is editing, for the Outliner and visuals. */
    remoteLocks(): Map<string, LockOwner>;
    /** May this client mutate `id` right now? */
    canEdit(id: string): boolean;
    /** All of them, or none: a partial group transform is not offered. */
    canEditAll(ids: readonly string[]): boolean;
    /**
     * Ask to edit `ids`. Returns true when the locks are already held, in
     * which case the caller may proceed immediately; otherwise `then` runs on
     * the grant.
     */
    acquire(ids: readonly string[], then?: () => void): boolean;
    /** Server said yes. */
    granted(ids: readonly string[]): void;
    /** Server said no. Nothing local has been mutated at this point. */
    denied(owner: string): void;
    /**
     * The server's authoritative lock table. This is also where a LOST lease
     * is detected: we believe we hold ids the server no longer attributes to
     * us (expiry, a reconnect race), so whatever is mid-gesture must roll back.
     */
    setOwners(owners: ReadonlyMap<string, LockOwner>): void;
    /** Deselect, cancel, switch target: give them back. */
    release(): void;
    /** Connection dropped: the server will expire the leases; forget locally. */
    disconnected(): void;
}
//# sourceMappingURL=lockController.d.ts.map