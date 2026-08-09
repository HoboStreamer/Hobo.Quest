/**
 * Wire-level DTO shapes shared by many messages.
 *
 * These are deliberately plain data (no branded ids, no domain classes):
 * the protocol layer is a boundary. Server/client map wire DTOs to and from
 * their own domain types. Encoding is currently JSON (see codec.ts); the
 * message model is transport-format agnostic so a binary codec can replace
 * it without touching message semantics.
 */

/** [x, y, z] — arrays keep JSON snapshots compact. */
export type WireVec3 = [number, number, number]

/** [x, y, z, w] unit quaternion. */
export type WireQuat = [number, number, number, number]

/** Input button bitfield. */
export const Buttons = {
  Jump: 1 << 0,
  Crouch: 1 << 1,
  Sprint: 1 << 2,
  Use: 1 << 3,
  Attack: 1 << 4,
} as const

/** How a wire entity should be represented client-side. */
export type WireEntityKind = 'player' | 'prop' | 'resource'

export interface WireEntity {
  id: string
  kind: WireEntityKind
  /** Content definition id (item def for props, node type for resources). */
  def?: string
  pos: WireVec3
  rot: WireQuat
  /** Physics motion state: dynamic | frozen (physgun-frozen) | static. */
  motion?: 'dynamic' | 'frozen' | 'static'
  /** Player display name, when kind === 'player'. */
  name?: string
  /** Persistent player id, when kind === 'player' (trust/friends target). */
  player?: string
  /** Owning player id, when kind === 'prop' and player-placed (prop protection). */
  owner?: string
  /** Remaining units, when kind === 'resource'. */
  remaining?: number
}

/** Per-tick dynamic state for an awake, relevant entity. */
export interface WireBodyState {
  id: string
  pos: WireVec3
  rot: WireQuat
}

export interface WirePlayerState {
  id: string
  pos: WireVec3
  vel: WireVec3
  yaw: number
  pitch: number
  grounded: boolean
}

export interface WireItemStack {
  def: string
  count: number
  /** Optional per-stack metadata (durability, quality...). */
  meta?: Record<string, number | string>
}

/** Inventory as sparse slot list; slot indices >= hotbar size are backpack. */
export interface WireInventory {
  size: number
  hotbar: number
  slots: { i: number; stack: WireItemStack }[]
}

export interface WireCraftJob {
  recipe: string
  /** Server tick when the job completes. */
  readyTick: number
}
