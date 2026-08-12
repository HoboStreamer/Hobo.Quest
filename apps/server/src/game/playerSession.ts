import type { Appearance, ClientInput } from '@hobo/protocol'
import type { ContentRegistry } from '@hobo/content'
import type { Inventory, SkillSet } from '@hobo/gameplay'
import {
  CraftQueue,
  createMoveState,
  eyeOffsetFor,
  normalizeStats,
  type PlayerMoveState,
  type SurvivalStats,
} from '@hobo/gameplay'
import type { EntityId, PlayerId, Quat, Vec3 } from '@hobo/shared'

export const INVENTORY_SIZE = 24
export const HOTBAR_SIZE = 6

/** Server-held physgun grab state. */
export interface HeldProp {
  entityId: EntityId
  /** Hold distance from the eye along the view ray (to the GRAB POINT). */
  dist: number
  /** Grab point in the body's local space — the prop hangs from where you
   * actually grabbed it, GMod-style, not from its center. */
  localOffset: Vec3
  /** Angle snap (Shift+E): quantizes the FULL world orientation each drive
   * tick — quantizing just the offsets is invisible on an arbitrary grab
   * pose, which is why offset-snapping never visibly worked. */
  snap: boolean
  snapStep: number
  /** Full body orientation at grab time, relative to the player's view yaw:
   * the prop keeps its exact pose (incl. tilt/roll) and turns with the view. */
  grabRot: Quat
  /** Grid-lock: quantize the drive target while held. */
  grid: boolean
  /** Grid cell size (m). */
  gridSize: number
}

/**
 * Per-connection authoritative player state. Everything gameplay-relevant
 * lives here on the server; the client only ever sees replicated copies.
 */
export interface PlayerSession {
  playerId: PlayerId
  entityId: EntityId
  token: string
  /** Character slot under the account token (0..2). */
  charSlot: number
  /** hobo.tools rank; gates edit mode + moderation. */
  rank: 'owner' | 'admin' | 'moderator' | null
  name: string
  move: PlayerMoveState
  /** Latest processed view angles (authoritative for ray origins). */
  yaw: number
  pitch: number
  buttons: number
  inventory: Inventory
  skills: SkillSet
  /** Player ids THIS player trusts with their props (one-directional). */
  friends: Set<string>
  appearance: Appearance
  craftQueue: CraftQueue
  activeHotbar: number
  /** Holstered: active slot's item is put away (empty hands). */
  holstered: boolean
  held: HeldProp | null
  /** LMB held with the physgun out: the beam is firing. While nothing is
   * latched the server re-tries the grab each tick (GMod sweep-to-grab). */
  grabbing: boolean
  /** Survival vitals (server-authoritative; replicated only to the owner). */
  stats: SurvivalStats
  /** Vitals changed since last stats message. */
  statsDirty: boolean
  /** Container prop this player currently has open (pushed on change). */
  openContainer: EntityId | null
  /** Most negative airborne vertical velocity (fall-damage tracking). */
  fallVy: number
  /** Tick of the last accepted use/swing (server-side swing cooldown). */
  lastUseTick: number
  /** Stance the kinematic physics body was last built for. */
  bodyStance: number
  /** For weld feedback and equipment lookups without threading the registry. */
  content: ContentRegistry
  /** Pending input commands (bounded queue: anti-speedup). */
  inputQueue: ClientInput[]
  lastInput: ClientInput | null
  /** Consecutive ticks simulated without a fresh input (jitter bridging). */
  starvedTicks: number
  lastProcessedSeq: number
  /** Entity ids this client currently knows about (interest management). */
  known: Set<EntityId>
  /** Player state changed since last persistence flush. */
  dirty: boolean
  send(text: string): void
  closeConnection(code: number, reason: string): void
}

export interface SessionInit {
  playerId: PlayerId
  entityId: EntityId
  token: string
  charSlot?: number
  rank?: 'owner' | 'admin' | 'moderator' | null
  name: string
  spawn: Vec3
  yaw: number
  inventory: Inventory
  skills: SkillSet
  friends: Set<string>
  appearance: Appearance
  stats?: Partial<SurvivalStats> | undefined
  content: ContentRegistry
  send(text: string): void
  closeConnection(code: number, reason: string): void
}

export function createSession(init: SessionInit): PlayerSession {
  return {
    playerId: init.playerId,
    entityId: init.entityId,
    token: init.token,
    charSlot: init.charSlot ?? 0,
    rank: init.rank ?? null,
    name: init.name,
    move: createMoveState(init.spawn),
    yaw: init.yaw,
    pitch: 0,
    buttons: 0,
    inventory: init.inventory,
    skills: init.skills,
    friends: init.friends,
    appearance: init.appearance,
    craftQueue: new CraftQueue(),
    activeHotbar: 0,
    holstered: false,
    held: null,
    grabbing: false,
    stats: normalizeStats(init.stats),
    statsDirty: true,
    openContainer: null,
    fallVy: 0,
    lastUseTick: 0,
    bodyStance: 0,
    content: init.content,
    inputQueue: [],
    lastInput: null,
    starvedTicks: 0,
    lastProcessedSeq: 0,
    known: new Set(),
    dirty: true,
    send: init.send,
    closeConnection: init.closeConnection,
  }
}

/** Eye position for view rays — stance-aware, matches the client camera. */
export function eyePosition(session: PlayerSession, out: Vec3): Vec3 {
  out.x = session.move.pos.x
  out.y = session.move.pos.y + eyeOffsetFor(session.move.stance)
  out.z = session.move.pos.z
  return out
}

/** View direction from authoritative yaw/pitch. */
export function viewDirection(session: PlayerSession, out: Vec3): Vec3 {
  const cp = Math.cos(session.pitch)
  out.x = Math.sin(session.yaw) * cp
  out.y = Math.sin(session.pitch)
  out.z = Math.cos(session.yaw) * cp
  return out
}
