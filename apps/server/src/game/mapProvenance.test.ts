/**
 * Map-authored entities are identified by PROVENANCE, not by proximity.
 *
 * Most of these cases are ones the old spatial rule got wrong: two authored
 * objects standing next to each other, and a player's construction standing
 * next to an authored one.
 */
import { describe, expect, it } from 'vitest'
import type { MapNodeSpawn, MapPropSpawn } from '@hobo/content'
import {
  planMapProvenance,
  provenanceState,
  readProvenance,
  type LiveProvenance,
} from './mapProvenance.js'

type Live = LiveProvenance & { id: string }

const nodeSpec = (s: MapNodeSpawn) => ({ id: s.id, defId: s.node, pos: s.pos })
const propSpec = (s: MapPropSpawn) => ({ id: s.id, defId: s.item, pos: s.pos })
const readLive = (e: Live): LiveProvenance => e

const node = (id: string, pos: [number, number, number], type = 'oak_tree'): MapNodeSpawn => ({
  id,
  node: type,
  pos,
})

/** Exactly the adapter `reconcileMapNodes` uses. */
const planNodes = (authored: readonly MapNodeSpawn[], live: readonly Live[]) =>
  planMapProvenance(authored, live, { spec: nodeSpec, entity: readLive })

/** An entity a map object authored. */
const seeded = (id: string, source: string, defId: string, x: number, z: number): Live => ({
  id,
  mapSourceId: source,
  defId,
  x,
  z,
})
/** An entity a player made. No provenance, ever. */
const player = (id: string, defId: string, x: number, z: number): Live => ({ id, defId, x, z })

const ids = (list: readonly Live[]) => list.map((e) => e.id)

describe('planMapProvenance', () => {
  it('leaves an unchanged seed completely alone', () => {
    const plan = planNodes([node('n1', [0, 0, 0])], [seeded('e1', 'n1', 'oak_tree', 0, 0)])
    expect(ids(plan.keep)).toEqual(['e1'])
    expect(plan.despawn).toEqual([])
    expect(plan.move).toEqual([])
    expect(plan.spawn).toEqual([])
  })

  it('keeps TWO authored objects 10 cm apart distinct', () => {
    // The one-metre rule collapsed these into one and silently dropped the
    // second on every save.
    const plan = planNodes(
      [node('n1', [0, 0, 0]), node('n2', [0.1, 0, 0])],
      [seeded('e1', 'n1', 'oak_tree', 0, 0), seeded('e2', 'n2', 'oak_tree', 0.1, 0)],
    )
    expect(ids(plan.keep)).toEqual(['e1', 'e2'])
    expect(plan.despawn).toEqual([])
    expect(plan.spawn).toEqual([])
  })

  it('does not let a PLAYER prop standing next to an authored one suppress it', () => {
    const plan = planMapProvenance(
      [{ id: 'p1', item: 'crate', pos: [0, 0, 0] } satisfies MapPropSpawn],
      [player('player-crate', 'crate', 0.5, 0.5)],
      { spec: propSpec, entity: readLive },
    )
    expect(plan.spawn.map((s) => s.id)).toEqual(['p1'])
    expect(plan.despawn).toEqual([])
  })

  it('never removes a player construction because a map seed disappeared', () => {
    const plan = planNodes([], [player('player-wall', 'wall', 0, 0)])
    expect(plan.despawn).toEqual([])
    expect(plan.keep).toEqual([])
  })

  it('MOVES a seed rather than spawning a duplicate', () => {
    // Beyond the old radius this spawned a second node and left the first,
    // losing whatever had been mined out of it.
    const plan = planNodes([node('n1', [20, 0, 20])], [seeded('e1', 'n1', 'oak_tree', 0, 0)])
    expect(plan.move).toHaveLength(1)
    expect(plan.move[0]!.entity.id).toBe('e1')
    expect(plan.move[0]!.spec.pos).toEqual([20, 0, 20])
    expect(plan.spawn).toEqual([])
    expect(plan.despawn).toEqual([])
  })

  it('does not move for sub-millimetre float noise', () => {
    const plan = planNodes([node('n1', [3, 0, 4])], [seeded('e1', 'n1', 'oak_tree', 3 + 1e-9, 4)])
    expect(plan.move).toEqual([])
    expect(ids(plan.keep)).toEqual(['e1'])
  })

  it('replaces a seed whose TYPE changed', () => {
    const plan = planNodes(
      [node('n1', [0, 0, 0], 'iron_deposit')],
      [seeded('e1', 'n1', 'oak_tree', 0, 0)],
    )
    expect(ids(plan.despawn)).toEqual(['e1'])
    expect(plan.spawn.map((s) => s.id)).toEqual(['n1'])
  })

  it('removes only the entity a deleted map object authored', () => {
    const plan = planNodes(
      [node('n2', [10, 0, 0])],
      [
        seeded('e1', 'n1', 'oak_tree', 0, 0),
        seeded('e2', 'n2', 'oak_tree', 10, 0),
        player('players-own', 'crate', 0.2, 0.2),
      ],
    )
    expect(ids(plan.despawn)).toEqual(['e1'])
    expect(ids(plan.keep)).toEqual(['e2'])
    expect(plan.spawn).toEqual([])
  })

  it('an unrelated save keeps every authored entity exactly as it was', () => {
    // "keep" is what preserves remaining/depletedUntil: a depleted node must
    // not be restocked because someone retextured a wall.
    const authored = [node('n1', [0, 0, 0]), node('n2', [5, 0, 5], 'iron_deposit')]
    const plan = planNodes(authored, [
      seeded('e1', 'n1', 'oak_tree', 0, 0),
      seeded('e2', 'n2', 'iron_deposit', 5, 5),
    ])
    expect(ids(plan.keep)).toEqual(['e1', 'e2'])
    expect(plan.despawn.length + plan.move.length + plan.spawn.length).toBe(0)
  })

  it('is idempotent: the second run spawns nothing', () => {
    const authored = [node('n1', [0, 0, 0])]
    expect(planNodes(authored, []).spawn.map((s) => s.id)).toEqual(['n1'])
    // After spawning, the entity carries the source id.
    expect(ids(planNodes(authored, [seeded('e1', 'n1', 'oak_tree', 0, 0)]).keep)).toEqual(['e1'])
  })

  it('a repeated save after a MOVE settles — it does not move forever', () => {
    const authored = [node('n1', [20, 0, 20])]
    expect(planNodes(authored, [seeded('e1', 'n1', 'oak_tree', 20, 20)]).move).toEqual([])
  })

  it('collapses a duplicated source to one entity', () => {
    // Only one entity can own a source; a second claiming it is a leftover.
    const plan = planNodes(
      [node('n1', [0, 0, 0])],
      [seeded('e1', 'n1', 'oak_tree', 0, 0), seeded('dupe', 'n1', 'oak_tree', 0, 0)],
    )
    expect(ids(plan.keep)).toEqual(['e1'])
    expect(ids(plan.despawn)).toEqual(['dupe'])
    expect(plan.spawn).toEqual([])
  })

  it('spawns every authored object of a map loaded onto an empty world', () => {
    const plan = planNodes([node('n1', [0, 0, 0]), node('n2', [1, 0, 1])], [])
    expect(plan.spawn.map((s) => s.id)).toEqual(['n1', 'n2'])
  })
})

describe('provenance persistence', () => {
  it('round-trips through the state blob', () => {
    expect(readProvenance({ remaining: 4, ...provenanceState('n1') })).toBe('n1')
  })

  it('writes NOTHING for a player-created entity', () => {
    // An empty key would be indistinguishable from a seed with a blank id.
    expect(provenanceState(undefined)).toEqual({})
    expect(readProvenance({ lootCount: 1 })).toBeUndefined()
  })

  it('ignores a malformed or absent state blob rather than throwing', () => {
    for (const bad of [null, undefined, 7, 'n1', [], { mapSourceId: 12 }, { mapSourceId: '' }])
      expect(readProvenance(bad)).toBeUndefined()
  })

  it('survives a restart: a restored seed is still recognised as its own', () => {
    // Without this the first save after a restart finds no entity for any
    // authored seed and duplicates the whole map.
    const persisted = { remaining: 2, ...provenanceState('n1') }
    const restored: Live = {
      id: 'e1',
      defId: 'oak_tree',
      x: 0,
      z: 0,
      ...(readProvenance(persisted) !== undefined
        ? { mapSourceId: readProvenance(persisted) }
        : {}),
    }
    const plan = planNodes([node('n1', [0, 0, 0])], [restored])
    expect(ids(plan.keep)).toEqual(['e1'])
    expect(plan.spawn).toEqual([])
  })
})
