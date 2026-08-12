import { describe, expect, it, vi } from 'vitest'
import { blankHeights, emptyMapV2, parseMapFile, type MapFileV2 } from '@hobo/content'
import { EditorDocument, type DocumentChange } from './editorDocument.js'

const SUB = 4

const terrain = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    pos: [0, 0, 0],
    halfExtent: 8,
    sub: SUB,
    heights: blankHeights(SUB),
    ...over,
  }) as never

const box = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as never

const zone = (id: string): never =>
  ({
    id,
    name: 'Zone',
    min: [-1, -1, -1],
    max: [1, 1, 1],
    rules: { pvp: true, build: true, physgun: true },
  }) as never

const light = (id: string): never => ({ id, type: 'point', pos: [0, 3, 0] }) as never

/** A document built through the real parser, so ids are the parsed ones. */
function parsed(raw: Partial<MapFileV2>): EditorDocument {
  const r = parseMapFile({ ...emptyMapV2(), ...raw })
  if (!r.ok) throw new Error(r.issues.join(', '))
  return new EditorDocument(r.map)
}

describe('EditorDocument: identity', () => {
  it('indexes every kind by its stable id', () => {
    const d = parsed({
      terrains: [terrain('t1')],
      statics: [box('s1')],
      nodes: [{ id: 'n1', node: 'oak_tree', pos: [0, 0, 0] }],
      props: [{ id: 'p1', item: 'crate', pos: [0, 0, 0] }],
      lights: [light('l1')],
      zones: [zone('z1')],
      spawn: [1, 2, 3],
      spawnYaw: 0.5,
    })
    expect(d.typeOf('t1')).toBe('terrain')
    expect(d.typeOf('s1')).toBe('static')
    expect(d.typeOf('n1')).toBe('node')
    expect(d.typeOf('p1')).toBe('prop')
    expect(d.typeOf('l1')).toBe('light')
    expect(d.typeOf('z1')).toBe('zone')
    expect(d.typeOf('spawn')).toBe('spawn')
    expect(d.typeOf('nope')).toBeNull()
    expect(d.list()).toHaveLength(7)
  })

  it('narrows by kind, refusing a mismatched read', () => {
    const d = parsed({ statics: [box('s1')] })
    expect(d.get('s1', 'static')?.id).toBe('s1')
    expect(d.get('s1', 'terrain')).toBeNull()
  })

  it('exposes spawn as a synthetic object and folds it back on serialize', () => {
    const d = parsed({ spawn: [4, 0, 5], spawnYaw: 1.25 })
    const s = d.get('spawn', 'spawn')!
    expect(s.pos).toEqual([4, 0, 5])
    expect(s.yaw).toBe(1.25)
    d.update('spawn', { pos: [9, 0, 9] })
    const wire = d.serialize()
    expect(wire.spawn).toEqual([9, 0, 9])
    expect(wire.spawnYaw).toBe(1.25)
  })

  it('omits spawn from the wire once removed', () => {
    const d = parsed({ spawn: [1, 0, 1] })
    d.remove('spawn')
    expect(d.serialize().spawn).toBeUndefined()
    expect(d.has('spawn')).toBe(false)
  })
})

describe('EditorDocument: the id index tracks the wire arrays', () => {
  // `get` reads an index rather than scanning; it is only correct if every
  // write keeps that index and the serialized arrays saying the same thing.
  it('returns the live object that serialize will write', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    d.update('s1', { pos: [3, 0, 4] })
    expect(d.get('s1', 'static')!.pos).toEqual([3, 0, 4])
    expect(d.serialize().statics[0]!.pos).toEqual([3, 0, 4])
  })

  it('replace swaps what BOTH the index and the array hold', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    d.replace('s1', box('s1', { pos: [7, 0, 7] }))
    expect((d.get('s1') as { pos: number[] }).pos).toEqual([7, 0, 7])
    expect(d.serialize().statics[0]!.pos).toEqual([7, 0, 7])
  })

  it('a removed object is gone from the index, not just the array', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    d.remove('s1')
    expect(d.get('s1')).toBeNull()
    expect(d.serialize().statics).toEqual([])
  })

  it('re-adding a removed id works and yields the NEW object', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    d.remove('s1')
    d.add('static', box('s1', { pos: [5, 0, 5] }))
    expect((d.get('s1') as { pos: number[] }).pos).toEqual([5, 0, 5])
  })

  it('a remote replacement rebuilds the index from the new document', () => {
    const d = parsed({ statics: [box('s1')] })
    d.replaceFromRemote(parsed({ statics: [box('s2')] }).serialize())
    expect(d.get('s1')).toBeNull()
    expect(d.get('s2', 'static')?.id).toBe('s2')
  })

  it('every object in list() is reachable by id', () => {
    const d = parsed({
      terrains: [terrain('t1')],
      statics: [box('s1'), box('s2')],
      lights: [light('l1')],
      zones: [zone('z1')],
      spawn: [0, 0, 0],
    })
    for (const o of d.list()) expect(d.get(o.id)).toBe(o)
  })
})

describe('EditorDocument: CRUD', () => {
  it('adds, updates and removes by id', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    expect(d.get('s1', 'static')!.pos).toEqual([0, 0, 0])
    d.update('s1', { pos: [5, 0, 5] })
    expect(d.get('s1', 'static')!.pos).toEqual([5, 0, 5])
    d.remove('s1')
    expect(d.has('s1')).toBe(false)
    expect(d.serialize().statics).toEqual([])
  })

  it('refuses a duplicate id rather than silently overwriting', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    expect(() => d.add('terrain', terrain('s1'))).toThrow(/already exists/)
  })

  it('refuses to change an id through update or replace', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    expect(() => d.update('s1', { id: 's2' } as never)).toThrow(/cannot change the id/)
    expect(() => d.replace('s1', box('s2'))).toThrow(/is not/)
  })

  it('deletes a key when the patch value is undefined', () => {
    const d = new EditorDocument()
    d.add('static', box('s1', { scale: [2, 2, 2] }))
    d.update('s1', { scale: undefined })
    expect(d.get('s1', 'static')!.scale).toBeUndefined()
  })

  it('copies on the way in and out, so callers cannot mutate it by accident', () => {
    const d = new EditorDocument()
    const source = box('s1') as unknown as { pos: number[] }
    d.add('static', source as never)
    source.pos[0] = 999
    expect(d.get('s1', 'static')!.pos[0]).toBe(0)
    const snap = d.snapshot('s1') as unknown as { pos: number[] }
    snap.pos[0] = 42
    expect(d.get('s1', 'static')!.pos[0]).toBe(0)
  })

  it('removing an unknown id is a no-op, not a throw', () => {
    const d = new EditorDocument()
    expect(() => d.remove('ghost')).not.toThrow()
  })
})

describe('EditorDocument: change feed', () => {
  const collect = (d: EditorDocument): DocumentChange[][] => {
    const seen: DocumentChange[][] = []
    d.subscribe((c) => seen.push([...c]))
    return seen
  }

  it('announces add, update, replace and remove', () => {
    const d = new EditorDocument()
    const seen = collect(d)
    d.add('static', box('s1'))
    d.update('s1', { pos: [1, 0, 0] })
    d.replace('s1', box('s1', { color: '#000000' }))
    d.remove('s1')
    expect(seen.flat().map((c) => c.type)).toEqual(['added', 'updated', 'replaced', 'removed'])
  })

  it('reports WHICH keys changed, so a view can skip work it does not need', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    const seen = collect(d)
    d.update('s1', { color: '#112233' })
    const change = seen[0]![0]!
    expect(change.type === 'updated' && change.keys).toEqual(['color'])
  })

  it('stays silent when an update changes nothing', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    const seen = collect(d)
    d.update('s1', { pos: [0, 0, 0] })
    expect(seen).toEqual([])
  })

  it('batches a transaction into ONE notification', () => {
    const d = new EditorDocument()
    d.add('static', box('a'))
    d.add('static', box('b'))
    const seen = collect(d)
    d.transact(() => {
      d.update('a', { pos: [1, 0, 0] })
      d.update('b', { pos: [2, 0, 0] })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
  })

  it('joins a nested transaction to the outer batch', () => {
    const d = new EditorDocument()
    d.add('static', box('a'))
    const seen = collect(d)
    d.transact(() => {
      d.update('a', { pos: [1, 0, 0] })
      d.transact(() => d.update('a', { pos: [2, 0, 0] }))
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
  })

  it('bumps the revision on every real mutation and only then', () => {
    const d = new EditorDocument()
    const r0 = d.revision
    d.add('static', box('s1'))
    expect(d.revision).toBe(r0 + 1)
    d.update('s1', { pos: [0, 0, 0] })
    expect(d.revision).toBe(r0 + 1)
  })

  it('unsubscribes cleanly', () => {
    const d = new EditorDocument()
    const listener = vi.fn()
    const off = d.subscribe(listener)
    d.add('static', box('a'))
    off()
    d.add('static', box('b'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('EditorDocument: remote replacement', () => {
  it('adopts the remote document and reindexes', () => {
    const d = parsed({ statics: [box('s1')] })
    const seen: DocumentChange[] = []
    d.subscribe((c) => seen.push(...c))
    const next = parseMapFile({ ...emptyMapV2(), statics: [box('s2')] })
    if (!next.ok) throw new Error('fixture')
    d.replaceFromRemote(next.map)
    expect(d.has('s1')).toBe(false)
    expect(d.has('s2')).toBe(true)
    expect(seen.map((c) => c.type)).toEqual(['documentReplaced'])
  })

  it('keeps identity for ids the remote save did not touch', () => {
    // The point of stable ids: a remote save that changed something else
    // must not invalidate what you have selected.
    const d = parsed({ statics: [box('keep'), box('gone')] })
    const next = parseMapFile({
      ...emptyMapV2(),
      statics: [box('keep', { pos: [7, 0, 7] }), box('added')],
    })
    if (!next.ok) throw new Error('fixture')
    d.replaceFromRemote(next.map)
    expect(d.typeOf('keep')).toBe('static')
    expect(d.get('keep', 'static')!.pos).toEqual([7, 0, 7])
    expect(d.has('gone')).toBe(false)
    expect(d.has('added')).toBe(true)
  })
})

describe('EditorDocument: serialization', () => {
  it('round-trips through the real parser', () => {
    const d = parsed({
      terrains: [terrain('t1')],
      statics: [box('s1')],
      zones: [zone('z1')],
      lights: [light('l1')],
      spawn: [0, 0, 0],
    })
    const again = parseMapFile(d.serialize())
    expect(again.ok, again.ok ? '' : again.issues.join(', ')).toBe(true)
    if (!again.ok) return
    expect(new EditorDocument(again.map).ids().sort()).toEqual(d.ids().sort())
  })

  it('serializes a detached copy — later edits do not leak into it', () => {
    const d = new EditorDocument()
    d.add('static', box('s1'))
    const wire = d.serialize()
    d.update('s1', { pos: [3, 3, 3] })
    expect(wire.statics[0]!.pos).toEqual([0, 0, 0])
  })
})

describe('EditorDocument: listByKind', () => {
  it('returns only that kind, in wire order', () => {
    const d = parsed({ statics: [box('a'), box('b')], terrains: [terrain('t')] })
    expect(d.listByKind('static').map((s) => s.id)).toEqual(['a', 'b'])
    expect(d.listByKind('terrain').map((t) => t.id)).toEqual(['t'])
    expect(d.listByKind('spawn')).toEqual([])
  })
})
