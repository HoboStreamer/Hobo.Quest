import { describe, expect, it } from 'vitest'
import type { NpcArchetype } from '@hobo/content'
import { perceive, stepBehavior, type NpcState } from './npc.js'

const HOSTILE: NpcArchetype = {
  id: 'thug',
  name: 'Thug',
  faction: 'rustjaw',
  health: 60,
  moveSpeed: 3,
  color: '#ff0000',
  radius: 0.35,
  heightM: 1.7,
  perception: { viewDistance: 20, fov: Math.PI, hearingDistance: 30 },
  behavior: {
    aggression: 'hostile',
    flees: false,
    wanders: true,
    leash: 30,
    attackDamage: 8,
    attackRange: 2,
    attackIntervalMs: 1000,
  },
  loot: [],
  respawnSeconds: 60,
}

const PREY: NpcArchetype = {
  ...HOSTILE,
  id: 'hare',
  behavior: { ...HOSTILE.behavior, aggression: 'passive', flees: true, attackDamage: 0 },
  perception: { viewDistance: 15, fov: Math.PI * 2, hearingDistance: 20 },
}

const npc = (over: Partial<NpcState> = {}): NpcState => ({
  id: 'n1',
  archetype: 'thug',
  x: 0,
  z: 0,
  yaw: 0,
  health: 60,
  homeX: 0,
  homeZ: 0,
  state: 'idle',
  stateUntil: 0,
  lastAttackMs: 0,
  respawnAt: 0,
  ...over,
})

const losAlways = () => true
const losNever = () => false

describe('perception', () => {
  it('sees hostile actors in range and FOV with line of sight', () => {
    const n = npc({ yaw: 0 }) // facing +z
    const p = perceive(n, HOSTILE, [{ id: 'p1', x: 0, z: 10, hostile: true }], [], losAlways)
    expect(p.threat?.id).toBe('p1')
  })

  it('respects field of view (target behind is invisible)', () => {
    const n = npc({ yaw: 0 })
    const p = perceive(n, HOSTILE, [{ id: 'p1', x: 0, z: -10, hostile: true }], [], losAlways)
    expect(p.threat).toBeNull()
    // The hare's 360° perception sees it anyway.
    const h = perceive(n, PREY, [{ id: 'p1', x: 0, z: -10, hostile: true }], [], losAlways)
    expect(h.threat?.id).toBe('p1')
  })

  it('walls block vision; distance limits apply; non-hostiles ignored', () => {
    const n = npc()
    expect(
      perceive(n, HOSTILE, [{ id: 'p1', x: 0, z: 10, hostile: true }], [], losNever).threat,
    ).toBeNull()
    expect(
      perceive(n, HOSTILE, [{ id: 'p1', x: 0, z: 50, hostile: true }], [], losAlways).threat,
    ).toBeNull()
    expect(
      perceive(n, HOSTILE, [{ id: 'p1', x: 0, z: 10, hostile: false }], [], losAlways).threat,
    ).toBeNull()
  })

  it('hears nearby sounds', () => {
    const n = npc()
    const p = perceive(n, HOSTILE, [], [{ x: 20, z: 0 }], losAlways)
    expect(p.sound).toEqual({ x: 20, z: 0 })
    expect(perceive(n, HOSTILE, [], [{ x: 200, z: 0 }], losAlways).sound).toBeNull()
  })
})

describe('behavior', () => {
  const rand = () => 0.5

  it('hostile NPCs chase visible threats and attack in range', () => {
    const n = npc()
    const chase = stepBehavior(
      n,
      HOSTILE,
      { threat: { id: 'p1', x: 10, z: 0, dist: 10 }, sound: null },
      1000,
      rand,
    )
    expect(chase.state).toBe('chase')
    expect(chase.moveX).toBe(10)
    const attack = stepBehavior(
      n,
      HOSTILE,
      { threat: { id: 'p1', x: 1, z: 0, dist: 1 }, sound: null },
      2000,
      rand,
    )
    expect(attack.state).toBe('attack')
    expect(attack.attackId).toBe('p1')
  })

  it('attack respects the cooldown', () => {
    const n = npc({ lastAttackMs: 1900 })
    const winding = stepBehavior(
      n,
      HOSTILE,
      { threat: { id: 'p1', x: 1, z: 0, dist: 1 }, sound: null },
      2000,
      rand,
    )
    expect(winding.state).toBe('attack')
    expect(winding.attackId).toBeUndefined()
  })

  it('fleeing archetypes run away from threats', () => {
    const n = npc()
    const flee = stepBehavior(
      n,
      PREY,
      { threat: { id: 'p1', x: 5, z: 0, dist: 5 }, sound: null },
      1000,
      rand,
    )
    expect(flee.state).toBe('flee')
    expect(flee.moveX).toBeLessThan(0) // away from +x threat
  })

  it('hostiles investigate sounds; leash pulls them home', () => {
    const investigate = stepBehavior(
      npc(),
      HOSTILE,
      { threat: null, sound: { x: 12, z: 0 } },
      1000,
      rand,
    )
    expect(investigate.state).toBe('chase')
    const strayed = npc({ x: 100, z: 0 })
    const back = stepBehavior(strayed, HOSTILE, { threat: null, sound: null }, 1000, rand)
    expect(back.state).toBe('return')
    expect(back.moveX).toBe(0)
    // Leashed NPCs do not chase threats beyond the leash.
    const leashed = stepBehavior(
      strayed,
      HOSTILE,
      { threat: { id: 'p1', x: 110, z: 0, dist: 10 }, sound: null },
      1000,
      rand,
    )
    expect(leashed.state).toBe('return')
  })

  it('idles and wanders around home when nothing happens', () => {
    const n = npc({ stateUntil: 0 })
    const first = stepBehavior(n, HOSTILE, { threat: null, sound: null }, 5000, () => 0.4)
    expect(first.state).toBe('wander')
    expect(Math.hypot((first.moveX ?? 0) - n.homeX, (first.moveZ ?? 0) - n.homeZ)).toBeLessThan(12)
    expect(n.stateUntil).toBeGreaterThan(5000)
  })
})
