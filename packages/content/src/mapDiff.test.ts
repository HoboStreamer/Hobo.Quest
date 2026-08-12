import { describe, expect, it } from 'vitest'
import { affectsCollision, describeDiff, diffMapFileV2 } from './mapDiff.js'
import { blankHeights, emptyMapV2, type MapFileV2 } from './mapFileV2.js'
import type { WorldDef } from './schema/world.js'

const SUB = 4

const terrain = (id: string, over: Record<string, unknown> = {}): MapFileV2['terrains'][number] =>
  ({
    id,
    pos: [0, 0, 0],
    halfExtent: 8,
    sub: SUB,
    heights: blankHeights(SUB),
    ...over,
  }) as MapFileV2['terrains'][number]

const box = (id: string, over: Record<string, unknown> = {}): MapFileV2['statics'][number] =>
  ({
    id,
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as MapFileV2['statics'][number]

const map = (over: Partial<MapFileV2> = {}): MapFileV2 => ({ ...emptyMapV2(), ...over })

describe('diffMapFileV2', () => {
  it('reports nothing for an identical repeated save', () => {
    const a = map({ statics: [box('s1')], terrains: [terrain('t1')] })
    const diff = diffMapFileV2(a, structuredClone(a))
    expect(diff.empty).toBe(true)
  })

  it('is key-order independent, like the canonical wire', () => {
    const a = map({ statics: [box('s1')] })
    const b = map({
      statics: [{ color: '#ffffff', yaw: 0, pos: [0, 0, 0], shape: box('s1').shape, id: 's1' }],
    })
    expect(diffMapFileV2(a, b).empty).toBe(true)
  })

  it('treats a reorder as no change — array position is not identity', () => {
    const a = map({ statics: [box('s1'), box('s2')] })
    const b = map({ statics: [box('s2'), box('s1')] })
    expect(diffMapFileV2(a, b).empty).toBe(true)
  })

  it('finds added, removed and changed objects by id', () => {
    const a = map({ statics: [box('keep'), box('gone')] })
    const b = map({ statics: [box('keep', { pos: [5, 0, 5] }), box('fresh')] })
    const d = diffMapFileV2(a, b)
    expect(d.statics.added.map((s) => s.id)).toEqual(['fresh'])
    expect(d.statics.removed.map((s) => s.id)).toEqual(['gone'])
    expect(d.statics.changed.map((c) => c.id)).toEqual(['keep'])
    expect(d.empty).toBe(false)
  })

  it('names the keys that differ', () => {
    const a = map({ statics: [box('s1')] })
    const b = map({ statics: [box('s1', { pos: [1, 0, 0], color: '#123456' })] })
    expect(diffMapFileV2(a, b).statics.changed[0]!.keys).toEqual(['color', 'pos'])
  })

  it('diffs every kind, not just statics', () => {
    const a = map({
      terrains: [terrain('t1')],
      nodes: [{ id: 'n1', node: 'oak_tree', pos: [0, 0, 0] }],
      props: [{ id: 'p1', item: 'crate', pos: [0, 0, 0] }],
      lights: [{ id: 'l1', type: 'point', pos: [0, 3, 0] }],
      zones: [
        {
          id: 'z1',
          name: 'Z',
          min: [0, 0, 0],
          max: [1, 1, 1],
          rules: { pvp: true, build: true, physgun: true },
        },
      ],
    })
    const d = diffMapFileV2(a, emptyMapV2())
    expect(d.terrains.removed).toHaveLength(1)
    expect(d.nodes.removed).toHaveLength(1)
    expect(d.props.removed).toHaveLength(1)
    expect(d.lights.removed).toHaveLength(1)
    expect(d.zones.removed).toHaveLength(1)
  })

  it('treats spawn as a value, not a set', () => {
    const a = map({ spawn: [0, 0, 0], spawnYaw: 0 })
    const b = map({ spawn: [1, 0, 0], spawnYaw: 0 })
    expect(diffMapFileV2(a, b).spawn.changed).toBe(true)
    expect(diffMapFileV2(a, structuredClone(a)).spawn.changed).toBe(false)
    // Adding a spawn where there was none counts too.
    expect(diffMapFileV2(emptyMapV2(), a).spawn.changed).toBe(true)
  })
})

describe('affectsCollision', () => {
  it('separates appearance changes from collision changes', () => {
    // Retinting a terrain must not tear down its heightfield body.
    expect(affectsCollision(['surface'])).toBe(false)
    expect(affectsCollision(['name'])).toBe(false)
    for (const k of ['pos', 'rot', 'scale', 'heights', 'halfExtent', 'sub'])
      expect(affectsCollision([k]), k).toBe(true)
    expect(affectsCollision(['surface', 'pos'])).toBe(true)
  })
})

describe('describeDiff', () => {
  it('summarises for the conflict dialog', () => {
    const a = map({ statics: [box('a')] })
    const b = map({ statics: [box('b')], spawn: [1, 1, 1] })
    expect(describeDiff(diffMapFileV2(a, b))).toEqual([
      'static: 1 added, 1 removed',
      'spawn point moved',
    ])
  })

  it('says nothing about a diff with nothing in it', () => {
    expect(describeDiff(diffMapFileV2(emptyMapV2(), emptyMapV2()))).toEqual([])
  })
})

describe('spawn is authoritative the moment a map is applied', () => {
  it('worldSpawn follows the override, so a live save changes future spawns', async () => {
    // No extra state is needed for this: worldSpawn reads the override at
    // CALL time, so the next spawn/respawn already uses the saved value.
    // Proven rather than assumed, because "it happens to work" is exactly
    // the kind of thing a refactor breaks silently.
    const { setMapOverride, worldSpawn } = await import('./terrain.js')
    const world = { spawnPoint: [1, 2, 3], spawnYaw: 0 } as never as WorldDef

    setMapOverride(null)
    expect(worldSpawn(world).pos).toEqual([1, 2, 3])

    setMapOverride({ terrains: [], spawn: [10, 0, 10], spawnYaw: 1.5 })
    expect(worldSpawn(world)).toEqual({ pos: [10, 0, 10], yaw: 1.5 })

    setMapOverride({ terrains: [], spawn: [-4, 0, 8], spawnYaw: 0.25 })
    expect(worldSpawn(world)).toEqual({ pos: [-4, 0, 8], yaw: 0.25 })

    // A map with no spawn falls back to the world def rather than the
    // previous map's value.
    setMapOverride({ terrains: [] })
    expect(worldSpawn(world).pos).toEqual([1, 2, 3])
    setMapOverride(null)
  })
})
