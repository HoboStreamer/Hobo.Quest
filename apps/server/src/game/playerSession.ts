import type { Appearance, ClientInput } from '@hobo/protocol'
import type { ContentRegistry } from '@hobo/content'
import type { Inventory, SkillSet } from '@hobo/gameplay'
import { CraftQueue, createMoveState, type PlayerMoveState } from '@hobo/gameplay'
import type { EntityId, PlayerId, Vec3 } from '@hobo/shared'

export const INVENTORY_SIZE = 24
export const HOTBAR_SIZE = 6

/** Server-held physgun grab state. */
export interface HeldProp {
  entityId: EntityId
  /** Hold distance from the eye along the view ray. */
  dist: number
  /** Player-applied rotation offsets (radians). */
  yawOffset: number
  pitchOffset: number
  /** Object yaw relative to player yaw at grab time, so it turns with the view. */
  grabYawDelta: number
}

/**
 * Per-connection authoritative player state. Everything gameplay-relevant
 * lives here on the server; the client only ever sees replicated copies.
 */
export interface PlayerSession {
  playerId: PlayerId
  entityId: EntityId
  token: string
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
  held: HeldProp | null
  /** Tick of the last accepted use/swing (server-side swing cooldown). */
  lastUseTick: number
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
  name: string
  spawn: Vec3
  yaw: number
  inventory: Inventory
  skills: SkillSet
  friends: Set<string>
  appearance: Appearance
  content: ContentRegistry
  send(text: string): void
  closeConnection(code: number, reason: string): void
}

export function createSession(init: SessionInit): PlayerSession {
  return {
    playerId: init.playerId,
    entityId: init.entityId,
    token: init.token,
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
    held: null,
    lastUseTick: 0,
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

/** Eye position for view rays — must match the client camera exactly. */
export function eyePosition(session: PlayerSession, eyeOffset: number, out: Vec3): Vec3 {
  out.x = session.move.pos.x
  out.y = session.move.pos.y + eyeOffset
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
