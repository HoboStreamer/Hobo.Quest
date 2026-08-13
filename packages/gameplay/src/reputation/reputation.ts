import type { FactionDef } from '@hobo/content'

/**
 * Player↔faction reputation: a persistent score per faction shifting the
 * faction's base stance. Actions move the score (trading up, killing
 * members down); thresholds decide how NPCs and merchants treat you.
 */

export type FactionStance = 'friendly' | 'neutral' | 'hostile'

/** Persistent shape: faction id -> score. */
export type ReputationDto = Record<string, number>

export const REP_MIN = -100
export const REP_MAX = 100

/** Score offsets the faction's base disposition contributes. */
const BASE_OFFSET: Record<FactionStance, number> = {
  friendly: 50,
  neutral: 0,
  hostile: -70,
}

const clamp = (v: number) => Math.max(REP_MIN, Math.min(REP_MAX, v))

export function addReputation(rep: ReputationDto, faction: string, delta: number): number {
  const next = clamp((rep[faction] ?? 0) + delta)
  rep[faction] = next
  return next
}

export function reputationOf(rep: ReputationDto, faction: string): number {
  return rep[faction] ?? 0
}

/**
 * Effective stance of a faction toward a player: base disposition plus
 * earned reputation. A hostile crew CAN be won over (rep ≥ +100 offsets
 * their −70 base); friendly folk turn on repeat offenders.
 */
export function stanceToward(faction: FactionDef, rep: ReputationDto): FactionStance {
  const score = BASE_OFFSET[faction.playerStance] + reputationOf(rep, faction.id)
  if (score >= 30) return 'friendly'
  if (score <= -30) return 'hostile'
  return 'neutral'
}

/** Reputation deltas for common actions (single source of truth). */
export const REP_DELTAS = {
  killMember: -15,
  trade: 2,
} as const
