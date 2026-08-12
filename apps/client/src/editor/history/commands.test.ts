import { describe, expect, it } from 'vitest'
import { blankHeights } from '@hobo/content'
import { CommandHistory } from './commandHistory.js'
import {
  addObject,
  applyHeightPatch,
  heightDelta,
  removeObject,
  removeObjects,
  setProperties,
  setPropertiesMany,
  terrainSculpt,
  transformObjects,
} from './commands.js'
import { EditorDocument } from '../document/editorDocument.js'
import { transformOf } from '../document/editorObject.js'
import { transformFromEuler } from '../viewport/transformMath.js'

const box = (id: string, over: Record<string, unknown> = {}): never =>
  ({
    id,
    shape: { type: 'box', size: [1, 1, 1] },
    pos: [0, 0, 0],
    yaw: 0,
    color: '#ffffff',
    ...over,
  }) as never

function setup(): { doc: EditorDocument; history: CommandHistory<EditorDocument> } {
  const doc = new EditorDocument()
  return { doc, history: new CommandHistory<EditorDocument>(doc) }
}

describe('object commands are exact inverses', () => {
  it('add → undo removes it; redo restores the SAME id and value', () => {
    const { doc, history } = setup()
    history.apply(addObject('static', box('s1', { pos: [3, 0, 3] })))
    expect(doc.get('s1', 'static')!.pos).toEqual([3, 0, 3])
    history.undo()
    expect(doc.has('s1')).toBe(false)
    history.redo()
    expect(doc.get('s1', 'static')!.pos).toEqual([3, 0, 3])
  })

  it('delete → undo restores the whole object under its original id', () => {
    // The old union stored a live reference, so undoing a delete restored an
    // object the meshes no longer knew about. Ids and values only.
    const { doc, history } = setup()
    doc.add('static', box('s1', { color: '#abcdef', scale: [2, 2, 2] }))
    const before = doc.snapshot('s1')
    history.apply(removeObject(doc, 's1')!)
    expect(doc.has('s1')).toBe(false)
    history.undo()
    expect(doc.snapshot('s1')).toEqual(before)
  })

  it('a multi-delete is ONE history entry', () => {
    const { doc, history } = setup()
    for (const id of ['a', 'b', 'c']) doc.add('static', box(id))
    history.apply(removeObjects(doc, ['a', 'b', 'c'])!)
    expect(history.depth).toBe(1)
    expect(doc.ids()).toEqual([])
    history.undo()
    expect(doc.ids().sort()).toEqual(['a', 'b', 'c'])
  })

  it('property edits restore an ABSENT key, not a zeroed one', () => {
    // A partial patch cannot express "this key was not there before", which
    // is exactly what undoing "give it a scale" has to restore.
    const { doc, history } = setup()
    doc.add('static', box('s1'))
    history.apply(setProperties(doc, 's1', { scale: [3, 3, 3] })!)
    expect(doc.get('s1', 'static')!.scale).toEqual([3, 3, 3])
    history.undo()
    expect(doc.get('s1', 'static')!.scale).toBeUndefined()
  })

  it('applies a property edit across a multi-selection as one entry', () => {
    const { doc, history } = setup()
    doc.add('static', box('a'))
    doc.add('static', box('b'))
    history.apply(setPropertiesMany(doc, ['a', 'b'], { color: '#010203' })!)
    expect(history.depth).toBe(1)
    expect(doc.get('a', 'static')!.color).toBe('#010203')
    expect(doc.get('b', 'static')!.color).toBe('#010203')
    history.undo()
    expect(doc.get('a', 'static')!.color).toBe('#ffffff')
  })

  it('returns null rather than a no-op command for a missing object', () => {
    const { doc } = setup()
    expect(removeObject(doc, 'ghost')).toBeNull()
    expect(setProperties(doc, 'ghost', { color: '#000000' })).toBeNull()
    expect(removeObjects(doc, ['ghost'])).toBeNull()
  })
})

describe('transformObjects', () => {
  it('moves a group and undoes to the exact starting poses', () => {
    const { doc, history } = setup()
    doc.add('static', box('a', { pos: [0, 0, 0] }))
    doc.add('static', box('b', { pos: [5, 0, 0] }))
    const before = [transformOf(doc, 'a')!, transformOf(doc, 'b')!]
    const after = [
      transformFromEuler([1, 0, 1], [0, 0, 0]),
      transformFromEuler([6, 0, 1], [0, 0, 0]),
    ]
    history.apply(transformObjects(['a', 'b'], before, after))
    expect(doc.get('a', 'static')!.pos).toEqual([1, 0, 1])
    history.undo()
    expect(doc.get('a', 'static')!.pos).toEqual([0, 0, 0])
    expect(doc.get('b', 'static')!.pos).toEqual([5, 0, 0])
    history.redo()
    expect(doc.get('b', 'static')!.pos).toEqual([6, 0, 1])
  })

  it('coalesces a scrub of the SAME ids into one entry, keeping the original before', () => {
    const { doc, history } = setup()
    doc.add('static', box('a'))
    const start = [transformOf(doc, 'a')!]
    // One gesture = one transaction; the frames inside it fold together.
    history.beginTransaction('scrub')
    for (let i = 1; i <= 5; i++)
      history.apply(transformObjects(['a'], start, [transformFromEuler([i, 0, 0], [0, 0, 0])]))
    history.commitTransaction()
    expect(history.depth).toBe(1)
    expect(doc.get('a', 'static')!.pos).toEqual([5, 0, 0])
    history.undo()
    expect(doc.get('a', 'static')!.pos).toEqual([0, 0, 0])
  })

  it('does NOT coalesce across different selections', () => {
    const { doc, history } = setup()
    doc.add('static', box('a'))
    doc.add('static', box('b'))
    // Two separate gestures stay two entries even inside one transaction:
    // they touch different objects.
    history.beginTransaction('two')
    history.apply(
      transformObjects(['a'], [transformOf(doc, 'a')!], [transformFromEuler([1, 0, 0], [0, 0, 0])]),
    )
    history.apply(
      transformObjects(['b'], [transformOf(doc, 'b')!], [transformFromEuler([2, 0, 0], [0, 0, 0])]),
    )
    history.commitTransaction()
    expect(doc.get('a', 'static')!.pos).toEqual([1, 0, 0])
    expect(doc.get('b', 'static')!.pos).toEqual([2, 0, 0])
  })

  it('transforms mixed kinds in one command', () => {
    const { doc, history } = setup()
    doc.add('static', box('s'))
    doc.add('terrain', {
      id: 't',
      pos: [0, 0, 0],
      halfExtent: 8,
      sub: 4,
      heights: blankHeights(4),
    } as never)
    const before = [transformOf(doc, 's')!, transformOf(doc, 't')!]
    const after = [
      transformFromEuler([2, 0, 0], [0, 0, 0]),
      transformFromEuler([2, 0, 0], [0, 0, 0]),
    ]
    history.apply(transformObjects(['s', 't'], before, after))
    expect(doc.get('t', 'terrain')!.pos).toEqual([2, 0, 0])
    history.undo()
    expect(doc.get('t', 'terrain')!.pos).toEqual([0, 0, 0])
  })

  it('skips a member that has since been deleted instead of throwing', () => {
    const { doc, history } = setup()
    doc.add('static', box('a'))
    const cmd = transformObjects(
      ['a', 'gone'],
      [transformOf(doc, 'a')!, transformFromEuler([0, 0, 0], [0, 0, 0])],
      [transformFromEuler([1, 0, 0], [0, 0, 0]), transformFromEuler([1, 0, 0], [0, 0, 0])],
    )
    expect(() => history.apply(cmd)).not.toThrow()
    expect(doc.get('a', 'static')!.pos).toEqual([1, 0, 0])
  })
})

describe('terrain height deltas', () => {
  const field = (n: number, fill = 0): Float32Array => new Float32Array(n * n).fill(fill)

  it('finds the minimal changed rectangle', () => {
    const before = field(8)
    const after = field(8)
    after[2 * 8 + 3] = 5
    after[4 * 8 + 5] = 7
    const patch = heightDelta(before, after, 8)!
    expect({ x: patch.x, y: patch.y, w: patch.w, h: patch.h }).toEqual({ x: 3, y: 2, w: 3, h: 3 })
  })

  it('stores kilobytes, not megabytes, for a small dab', () => {
    // The whole point: a 512² field is a megabyte of Float32 per snapshot.
    const n = 512
    const before = new Float32Array(n * n)
    const after = new Float32Array(n * n)
    for (let y = 250; y < 256; y++) for (let x = 250; x < 256; x++) after[y * n + x] = 1
    const patch = heightDelta(before, after, n)!
    const bytes = patch.before.byteLength + patch.after.byteLength
    expect(bytes).toBeLessThan(1024)
    expect(before.byteLength).toBeGreaterThan(1_000_000)
  })

  it('reports no delta when nothing changed', () => {
    expect(heightDelta(field(8), field(8), 8)).toBeNull()
  })

  it('applies exactly, in both directions', () => {
    const before = field(8)
    const after = field(8)
    for (let i = 20; i < 26; i++) after[i] = i
    const patch = heightDelta(before, after, 8)!
    const live = before.slice()
    applyHeightPatch(live, 8, patch, 'after')
    expect([...live]).toEqual([...after])
    applyHeightPatch(live, 8, patch, 'before')
    expect([...live]).toEqual([...before])
  })

  it('a sculpt stroke is one entry and undoes exactly', () => {
    const { doc, history } = setup()
    const n = 8
    const heights = new Float32Array(n * n)
    doc.add('terrain', {
      id: 't',
      pos: [0, 0, 0],
      halfExtent: 8,
      sub: n - 1,
      heights: blankHeights(n - 1),
    } as never)
    const before = heights.slice()
    heights[30] = 4
    const patch = heightDelta(before, heights, n)!
    history.apply(terrainSculpt('t', patch, n, (_id, apply) => apply(heights)))
    expect(history.depth).toBe(1)
    history.undo()
    expect(heights[30]).toBe(0)
    history.redo()
    expect(heights[30]).toBe(4)
  })
})

describe('dirty tracking through the saved checkpoint', () => {
  it('save → edit → dirty → undo → clean → redo → dirty', () => {
    const { doc, history } = setup()
    doc.add('static', box('a'))
    history.markSaved()
    expect(history.isDirty()).toBe(false)
    history.apply(setProperties(doc, 'a', { color: '#111111' })!)
    expect(history.isDirty()).toBe(true)
    history.undo()
    expect(history.isDirty()).toBe(false)
    history.redo()
    expect(history.isDirty()).toBe(true)
  })
})
