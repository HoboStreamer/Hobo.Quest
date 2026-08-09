import type { ClientInput } from '@hobo/protocol';
import type { Inventory } from '@hobo/gameplay';
import { CraftQueue, type PlayerMoveState } from '@hobo/gameplay';
import type { EntityId, PlayerId, Vec3 } from '@hobo/shared';
export declare const INVENTORY_SIZE = 24;
export declare const HOTBAR_SIZE = 6;
/** Server-held physgun grab state. */
export interface HeldProp {
    entityId: EntityId;
    /** Hold distance from the eye along the view ray. */
    dist: number;
    /** Player-applied rotation offsets (radians). */
    yawOffset: number;
    pitchOffset: number;
    /** Object yaw relative to player yaw at grab time, so it turns with the view. */
    grabYawDelta: number;
}
/**
 * Per-connection authoritative player state. Everything gameplay-relevant
 * lives here on the server; the client only ever sees replicated copies.
 */
export interface PlayerSession {
    playerId: PlayerId;
    entityId: EntityId;
    token: string;
    name: string;
    move: PlayerMoveState;
    /** Latest processed view angles (authoritative for ray origins). */
    yaw: number;
    pitch: number;
    buttons: number;
    inventory: Inventory;
    craftQueue: CraftQueue;
    activeHotbar: number;
    held: HeldProp | null;
    /** Pending input commands (bounded queue: anti-speedup). */
    inputQueue: ClientInput[];
    lastInput: ClientInput | null;
    /** Consecutive ticks simulated without a fresh input (jitter bridging). */
    starvedTicks: number;
    lastProcessedSeq: number;
    /** Entity ids this client currently knows about (interest management). */
    known: Set<EntityId>;
    /** Player state changed since last persistence flush. */
    dirty: boolean;
    send(text: string): void;
    closeConnection(code: number, reason: string): void;
}
export interface SessionInit {
    playerId: PlayerId;
    entityId: EntityId;
    token: string;
    name: string;
    spawn: Vec3;
    yaw: number;
    inventory: Inventory;
    send(text: string): void;
    closeConnection(code: number, reason: string): void;
}
export declare function createSession(init: SessionInit): PlayerSession;
/** Eye position for view rays — must match the client camera exactly. */
export declare function eyePosition(session: PlayerSession, eyeOffset: number, out: Vec3): Vec3;
/** View direction from authoritative yaw/pitch. */
export declare function viewDirection(session: PlayerSession, out: Vec3): Vec3;
//# sourceMappingURL=playerSession.d.ts.map