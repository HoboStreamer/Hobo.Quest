import type {
  WireBodyState,
  WireCraftJob,
  WireEntity,
  WireInventory,
  WirePlayerState,
  WirePlant,
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
  /** Planter crop changed (null clears after harvest). */
  plant?: WirePlant | null
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
  action:
    | 'craft'
    | 'drop'
    | 'use'
    | 'inv_move'
    | 'physgun'
    | 'weld'
    | 'unweld'
    | 'trust'
    | 'consume'
    | 'container'
    | 'trade'
  ok: boolean
  error?: string
}

/** The receiving player's trusted-friends list (welcome + on change). */
export interface ServerFriends {
  t: 'friends'
  friends: { id: string; name: string }[]
}

export interface WireSkill {
  id: string
  level: number
  xp: number
  nextXp: number
}

/** Full skill progression for the receiving player (welcome + on change). */
export interface ServerSkills {
  t: 'skills'
  skills: WireSkill[]
}

export interface ServerLevelUp {
  t: 'levelup'
  skill: string
  level: number
}

/** A weld now exists (or was removed) between two props — for client feedback/visuals. */
export interface ServerWeldState {
  t: 'weld_state'
  a: string
  b: string
  active: boolean
}

/** Physgun beam state for rendering (any player's beam). */
export interface ServerPhysgunState {
  t: 'physgun_state'
  player: string
  /** Held entity id, or null when the beam turned off. */
  target: string | null
  /** Grab point in the held body's LOCAL space — beams attach to the spot
   * the beam first touched, not the prop's center. */
  grab?: [number, number, number]
}

/** The receiving player's own vitals (sent on meaningful change). */
export interface ServerStats {
  t: 'stats'
  hp: number
  hunger: number
  thirst: number
  stamina: number
  /** Set on the update that killed you (client shows death feedback). */
  died?: boolean
}

/** World clock sync: fraction of the day cycle [0..1). */
export interface ServerTime {
  t: 'time'
  frac: number
}

/** World-event banner shown to everyone (supply drops etc.). */
export interface ServerAnnounce {
  t: 'announce'
  text: string
}

/** Contents of an opened container (and pushed while it stays open). */
export interface ServerContainer {
  t: 'container'
  id: string
  slots: { i: number; def: string; count: number }[]
  size: number
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
  | ServerSkills
  | ServerLevelUp
  | ServerWeldState
  | ServerFriends
  | ServerStats
  | ServerTime
  | ServerContainer
  | ServerAnnounce
