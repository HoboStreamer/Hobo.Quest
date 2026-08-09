import type {
  WireBodyState,
  WireCraftJob,
  WireEntity,
  WireInventory,
  WirePlayerState,
} from '../wire.js'

/**
 * Server -> client messages. Plain types (no zod): the client trusts the
 * server. Kept as a discriminated union on `t` for exhaustive handling.
 */

export interface ServerWelcome {
  t: 'welcome'
  v: number
  playerId: string
  /** The player's own world entity id. */
  entityId: string
  tick: number
  tickRate: number
  snapshotRate: number
}

export interface ServerReject {
  t: 'reject'
  reason: 'protocol_mismatch' | 'server_full' | 'invalid_hello'
}

/** Entities that became relevant to this client (full state). */
export interface ServerSpawn {
  t: 'spawn'
  entities: WireEntity[]
}

export interface ServerDespawn {
  t: 'despawn'
  ids: string[]
}

/**
 * Periodic delta snapshot: authoritative player states plus transforms of
 * awake, relevant physics bodies. Sleeping/settled entities are represented
 * by their last Spawn state and simply stop appearing here — that, plus
 * interest management, is what keeps large worlds cheap on the wire.
 */
export interface ServerSnapshot {
  t: 'snap'
  tick: number
  /** Last input seq processed for the receiving player (reconciliation). */
  ack: number
  players: WirePlayerState[]
  bodies: WireBodyState[]
}

/** Motion-state change for an already-spawned entity (freeze, sleep-settle). */
export interface ServerEntityUpdate {
  t: 'entity'
  id: string
  motion?: 'dynamic' | 'frozen' | 'static'
  pos?: [number, number, number]
  rot?: [number, number, number, number]
  remaining?: number
}

export interface ServerInventory {
  t: 'inventory'
  inv: WireInventory
  activeHotbar: number
}

export interface ServerCraftState {
  t: 'craft_state'
  jobs: WireCraftJob[]
}

/** Result of an explicit player request (craft, place, use...). */
export interface ServerActionResult {
  t: 'result'
  action: 'craft' | 'place' | 'use' | 'inv_move' | 'physgun'
  ok: boolean
  error?: string
}

/** Physgun beam state for rendering (any player's beam). */
export interface ServerPhysgunState {
  t: 'physgun_state'
  player: string
  /** Held entity id, or null when the beam turned off. */
  target: string | null
}

export type ServerMessage =
  | ServerWelcome
  | ServerReject
  | ServerSpawn
  | ServerDespawn
  | ServerSnapshot
  | ServerEntityUpdate
  | ServerInventory
  | ServerCraftState
  | ServerActionResult
  | ServerPhysgunState
