import type { FactionDef, NpcArchetype } from '../schema/npc.js'

/**
 * NPC content: factions, archetypes, and world spawn points. Behavior is
 * profile-driven — a bandit is hostile data, not a Bandit class.
 */

export const FACTIONS: FactionDef[] = [
  { id: 'drifters', name: 'Drifters', playerStance: 'friendly' },
  { id: 'hoboville', name: 'Hoboville Folk', playerStance: 'friendly' },
  { id: 'rustjaw', name: 'Rustjaw Crew', playerStance: 'hostile' },
  { id: 'wildlife', name: 'Wildlife', playerStance: 'neutral' },
]

export const NPC_ARCHETYPES: NpcArchetype[] = [
  {
    id: 'rustjaw_thug',
    name: 'Rustjaw Thug',
    faction: 'rustjaw',
    health: 60,
    moveSpeed: 3.4,
    color: '#7a3a2a',
    radius: 0.35,
    heightM: 1.75,
    perception: { viewDistance: 18, fov: Math.PI * 1.2, hearingDistance: 30 },
    behavior: {
      aggression: 'hostile',
      flees: false,
      wanders: true,
      leash: 35,
      attackDamage: 9,
      attackRange: 1.9,
      attackIntervalMs: 1300,
    },
    loot: [
      { item: 'scrap_metal', count: 2, chance: 1 },
      { item: 'coin', count: 3, chance: 0.6 },
      { item: 'pistol_round', count: 3, chance: 0.35 },
    ],
    respawnSeconds: 240,
  },
  {
    id: 'city_warden',
    name: 'City Warden',
    faction: 'hoboville',
    health: 140,
    moveSpeed: 4.2,
    color: '#2a4a7a',
    radius: 0.38,
    heightM: 1.85,
    perception: { viewDistance: 22, fov: Math.PI * 1.4, hearingDistance: 40 },
    behavior: {
      aggression: 'defensive',
      flees: false,
      wanders: true,
      leash: 25,
      attackDamage: 16,
      attackRange: 2.1,
      attackIntervalMs: 1100,
    },
    loot: [],
    respawnSeconds: 120,
  },
  {
    id: 'townsfolk',
    name: 'Townsfolk',
    faction: 'hoboville',
    health: 50,
    moveSpeed: 2.4,
    color: '#6a6a4a',
    radius: 0.34,
    heightM: 1.68,
    perception: { viewDistance: 14, fov: Math.PI, hearingDistance: 20 },
    behavior: {
      aggression: 'passive',
      flees: true,
      wanders: true,
      leash: 18,
      attackDamage: 0,
      attackRange: 1.5,
      attackIntervalMs: 2000,
    },
    loot: [],
    respawnSeconds: 90,
  },
  {
    id: 'dust_hare',
    name: 'Dust Hare',
    faction: 'wildlife',
    health: 14,
    moveSpeed: 5.2,
    color: '#9a8a6a',
    radius: 0.22,
    heightM: 0.5,
    perception: { viewDistance: 16, fov: Math.PI * 1.8, hearingDistance: 24 },
    behavior: {
      aggression: 'passive',
      flees: true,
      wanders: true,
      leash: 40,
      attackDamage: 0,
      attackRange: 1,
      attackIntervalMs: 2000,
    },
    loot: [{ item: 'berries', count: 2, chance: 1 }],
    respawnSeconds: 150,
  },
]

/** World NPC spawn points (positions are terrain-relative, like props). */
export const NPC_SPAWNS: { archetype: string; pos: [number, number, number] }[] = [
  // Rustjaw ambushers haunt the scrapyard and the deep forest.
  { archetype: 'rustjaw_thug', pos: [43, 0, -40] },
  { archetype: 'rustjaw_thug', pos: [40, 0, 48] },
  // Wardens hold the city plaza.
  { archetype: 'city_warden', pos: [6, 0, 10] },
  // Townsfolk mill about the market.
  { archetype: 'townsfolk', pos: [10, 0, 8] },
  { archetype: 'townsfolk', pos: [-8, 0, 12] },
  // Hares in the east fields.
  { archetype: 'dust_hare', pos: [55, 0, 6] },
  { archetype: 'dust_hare', pos: [58, 0, -8] },
]
