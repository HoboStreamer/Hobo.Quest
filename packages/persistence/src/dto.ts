import type { InventoryDto, SkillsDto } from '@hobo/gameplay'
import type { Appearance } from '@hobo/protocol'

/**
 * Persistence DTOs: the explicit, versionable disk representation of game
 * state. Runtime objects (Babylon meshes, Havok bodies, live Inventory
 * instances) are transient — they are rebuilt FROM these records, never
 * serialized directly.
 */

export interface WorldEntityDto {
  id: string
  kind: 'prop' | 'resource'
  defId: string
  ownerId: string | null
  pos: [number, number, number]
  rot: [number, number, number, number]
  motion: 'dynamic' | 'frozen' | 'static'
  /** Kind-specific extra state (resource remaining, container slots...) as JSON. */
  state: Record<string, unknown> | null
  updatedAt: number
}

export interface PlayerDto {
  id: string
  /** Identity token from the client (interim auth; see ADR-0004). */
  token: string
  name: string
  pos: [number, number, number]
  yaw: number
  inventory: InventoryDto
  /** Total XP per skill id (levels are derived at runtime). */
  skills: SkillsDto
  /** Player ids this player trusts with their props (one-directional). */
  friends: string[]
  /** Avatar customization; null until the player first customizes. */
  appearance: Appearance | null
  /** Character slot under this account token (0..2, MMO-style). */
  charSlot: number
  /** Survival vitals; null for players from before the survival system. */
  stats: { health: number; hunger: number; thirst: number; stamina: number } | null
  updatedAt: number
}

/** Persistent constraint between two world entities (weld graphs, later hinges etc.). */
export interface ConstraintDto {
  id: string
  type: 'weld'
  entityA: string
  entityB: string
  updatedAt: number
}
