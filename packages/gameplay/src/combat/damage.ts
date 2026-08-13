/**
 * Generic damage pipeline: every hit — melee swing, bullet, explosion,
 * exposure, fall — flows through one typed event and one mitigation rule
 * set. Systems producing damage never know about armor; systems owning
 * health never know about weapons.
 */

export type DamageType = 'blunt' | 'cutting' | 'projectile' | 'explosive' | 'environment' | 'fall'

export interface DamageEvent {
  type: DamageType
  amount: number
  /** Entity id of the attacker/cause, when one exists. */
  sourceId?: string
}

export interface ArmorInfo {
  /** Fraction of incoming damage absorbed (0..0.9). */
  reduction: number
}

/** Damage types armor cannot help against. */
const UNMITIGATED: ReadonlySet<DamageType> = new Set(['environment', 'fall'])

/** Applies armor mitigation to a damage event. */
export function mitigate(event: DamageEvent, armor: ArmorInfo | null): number {
  if (!armor || UNMITIGATED.has(event.type)) return event.amount
  return event.amount * (1 - Math.min(0.9, Math.max(0, armor.reduction)))
}

/** Hits at or above this post-mitigation damage can open wounds. */
export const BLEED_THRESHOLD = 12
export const BLEED_SECONDS = 12

/** Should this hit cause bleeding? (Cutting/projectile wounds only.) */
export function causesBleeding(type: DamageType, mitigatedAmount: number): boolean {
  return (type === 'cutting' || type === 'projectile') && mitigatedAmount >= BLEED_THRESHOLD
}

// ── Ranged weapon fire control (pure state machine) ──────────────────

export interface RangedWeaponSpec {
  damage: number
  range: number
  fireIntervalMs: number
  /** Cone half-angle, degrees. */
  spreadDeg: number
  ammoItem: string
  magazine: number
  reloadMs: number
}

/** Per-weapon-instance state (kept in stack meta as numbers). */
export interface WeaponInstanceState {
  /** Rounds currently loaded. */
  mag: number
  /** Epoch ms of the last accepted shot. */
  lastFireMs: number
  /** Epoch ms a running reload completes (0 = not reloading). */
  reloadUntil: number
}

export type FireDenial = 'empty' | 'too_fast' | 'reloading'

/** Validates a fire request against authoritative weapon state. */
export function canFire(
  state: WeaponInstanceState,
  spec: RangedWeaponSpec,
  nowMs: number,
): FireDenial | 'ok' {
  if (state.reloadUntil > nowMs) return 'reloading'
  if (state.mag <= 0) return 'empty'
  // 10% cadence slack: honest clients at the edge of the interval must not
  // be punished for jitter; sustained faster-than-interval fire still fails.
  if (nowMs - state.lastFireMs < spec.fireIntervalMs * 0.9) return 'too_fast'
  return 'ok'
}

/** Records an accepted shot. */
export function recordShot(state: WeaponInstanceState, nowMs: number): void {
  state.mag -= 1
  state.lastFireMs = nowMs
}

/**
 * Starts a reload: returns how many rounds to consume from the inventory
 * (0 = nothing to do — full mag or no ammo available).
 */
export function startReload(
  state: WeaponInstanceState,
  spec: RangedWeaponSpec,
  ammoAvailable: number,
  nowMs: number,
): number {
  if (state.reloadUntil > nowMs) return 0
  const want = spec.magazine - state.mag
  const take = Math.min(want, ammoAvailable)
  if (take <= 0) return 0
  state.mag += take
  state.reloadUntil = nowMs + spec.reloadMs
  return take
}

/** Reads weapon instance state out of stack meta (all-number encoding). */
export function weaponStateFromMeta(
  meta: Record<string, number | string> | undefined,
): WeaponInstanceState {
  return {
    mag: typeof meta?.mag === 'number' ? meta.mag : 0,
    lastFireMs: typeof meta?.lastFireMs === 'number' ? meta.lastFireMs : 0,
    reloadUntil: typeof meta?.reloadUntil === 'number' ? meta.reloadUntil : 0,
  }
}

export function weaponStateToMeta(
  state: WeaponInstanceState,
  meta: Record<string, number | string> | undefined,
): Record<string, number | string> {
  return {
    ...meta,
    mag: state.mag,
    lastFireMs: state.lastFireMs,
    reloadUntil: state.reloadUntil,
  }
}
