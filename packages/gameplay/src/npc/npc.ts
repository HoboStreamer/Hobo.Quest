import type { NpcArchetype } from '@hobo/content'

/**
 * NPC domain: pure state + deterministic behavior transitions. The server
 * owns instances, perception feeds decisions, and a NavigationService
 * boundary turns decisions into waypoints — no engine types anywhere.
 */

export type NpcBehaviorState = 'idle' | 'wander' | 'chase' | 'attack' | 'flee' | 'return'

export interface NpcState {
  /** Stable instance id (also the world entity id when materialized). */
  id: string
  archetype: string
  x: number
  z: number
  yaw: number
  health: number
  /** Spawn anchor: wander center, leash origin, respawn point. */
  homeX: number
  homeZ: number
  state: NpcBehaviorState
  /** Current movement target (waypoint), if any. */
  targetX?: number
  targetZ?: number
  /** Entity id being chased/attacked. */
  threatId?: string
  /** Epoch ms when the current idle/wander leg expires. */
  stateUntil: number
  lastAttackMs: number
  /** Dead + waiting to respawn at this epoch ms (0 = alive). */
  respawnAt: number
}

export interface PerceivedThreat {
  id: string
  x: number
  z: number
  dist: number
}

export interface NpcPerception {
  /** Closest visible threat (faction-hostile actor), if any. */
  threat: PerceivedThreat | null
  /** Loudest relevant sound this tick (gunshots, fights), if any. */
  sound: { x: number; z: number } | null
}

/** What perception knows about a candidate actor. */
export interface PerceptionCandidate {
  id: string
  x: number
  z: number
  /** Is this actor hostile to the perceiving NPC (faction/aggro logic)? */
  hostile: boolean
}

/**
 * Vision + hearing: distance, field of view, and an injected line-of-sight
 * test (the server binds a physics raycast; tests bind analytic worlds).
 */
export function perceive(
  npc: NpcState,
  arch: NpcArchetype,
  candidates: readonly PerceptionCandidate[],
  sounds: readonly { x: number; z: number }[],
  hasLineOfSight: (fromX: number, fromZ: number, toX: number, toZ: number) => boolean,
): NpcPerception {
  let threat: PerceivedThreat | null = null
  for (const c of candidates) {
    if (!c.hostile) continue
    const dx = c.x - npc.x
    const dz = c.z - npc.z
    const dist = Math.hypot(dx, dz)
    if (dist > arch.perception.viewDistance) continue
    // FOV check (full-circle perception skips it).
    if (arch.perception.fov < Math.PI * 2 - 1e-6) {
      const toward = Math.atan2(dx, dz)
      let delta = toward - npc.yaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      if (Math.abs(delta) > arch.perception.fov / 2) continue
    }
    if (!hasLineOfSight(npc.x, npc.z, c.x, c.z)) continue
    if (!threat || dist < threat.dist) threat = { id: c.id, x: c.x, z: c.z, dist }
  }
  let sound: { x: number; z: number } | null = null
  let bestSound = Infinity
  for (const s of sounds) {
    const dist = Math.hypot(s.x - npc.x, s.z - npc.z)
    if (dist <= arch.perception.hearingDistance && dist < bestSound) {
      bestSound = dist
      sound = { x: s.x, z: s.z }
    }
  }
  return { threat, sound }
}

export interface BehaviorDecision {
  state: NpcBehaviorState
  /** Waypoint to walk toward (absent = stand still). */
  moveX?: number
  moveZ?: number
  /** Attack this entity now (in range, cooldown ready). */
  attackId?: string
}

/**
 * One deterministic behavior step. Composition over subclasses: the
 * archetype's profile fields (aggression/flees/wanders/leash) shape the
 * transitions; there is no per-archetype code.
 */
export function stepBehavior(
  npc: NpcState,
  arch: NpcArchetype,
  perception: NpcPerception,
  nowMs: number,
  rand: () => number,
): BehaviorDecision {
  const b = arch.behavior
  const homeDist = Math.hypot(npc.x - npc.homeX, npc.z - npc.homeZ)

  // Threat responses come first.
  if (perception.threat) {
    const t = perception.threat
    if (b.flees) {
      // Run directly away from the threat.
      const dx = npc.x - t.x
      const dz = npc.z - t.z
      const len = Math.hypot(dx, dz) || 1
      return {
        state: 'flee',
        moveX: npc.x + (dx / len) * 10,
        moveZ: npc.z + (dz / len) * 10,
      }
    }
    if (b.aggression !== 'passive' && b.attackDamage > 0) {
      if (t.dist <= b.attackRange) {
        if (nowMs - npc.lastAttackMs >= b.attackIntervalMs) {
          return { state: 'attack', attackId: t.id }
        }
        return { state: 'attack' } // in range, winding up
      }
      if (homeDist <= b.leash) {
        return { state: 'chase', moveX: t.x, moveZ: t.z }
      }
    }
  }

  // Heard something (and would care): investigate toward it.
  if (perception.sound && b.aggression === 'hostile' && homeDist <= b.leash) {
    return { state: 'chase', moveX: perception.sound.x, moveZ: perception.sound.z }
  }

  // Leash: too far from home — walk back.
  if (homeDist > b.leash) {
    return { state: 'return', moveX: npc.homeX, moveZ: npc.homeZ }
  }

  // Idle/wander cadence.
  if (nowMs >= npc.stateUntil) {
    if (b.wanders && rand() < 0.6) {
      const angle = rand() * Math.PI * 2
      const dist = 3 + rand() * 8
      npc.stateUntil = nowMs + 4000 + rand() * 6000
      return {
        state: 'wander',
        moveX: npc.homeX + Math.sin(angle) * dist,
        moveZ: npc.homeZ + Math.cos(angle) * dist,
      }
    }
    npc.stateUntil = nowMs + 3000 + rand() * 5000
    return { state: 'idle' }
  }
  // Keep doing what we're doing.
  if (npc.state === 'wander' && npc.targetX !== undefined && npc.targetZ !== undefined) {
    return { state: 'wander', moveX: npc.targetX, moveZ: npc.targetZ }
  }
  return { state: npc.state === 'wander' ? 'wander' : 'idle' }
}

/**
 * Navigation boundary: gameplay asks for paths; implementations decide how
 * (straight line today, navmesh/grid later — player construction will
 * demand invalidation, hence the seam).
 */
export interface NavigationService {
  /** Waypoints from A to B, or null when unreachable. */
  requestPath(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
  ): { x: number; z: number }[] | null
}

/** v1 navigation: open-terrain straight line (one waypoint). */
export class StraightLineNavigation implements NavigationService {
  requestPath(
    _fromX: number,
    _fromZ: number,
    toX: number,
    toZ: number,
  ): { x: number; z: number }[] {
    return [{ x: toX, z: toZ }]
  }
}
