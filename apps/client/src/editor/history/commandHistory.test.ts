import { describe, expect, it } from 'vitest'
import {
  CommandHistory,
  compositeCommand,
  snapshotCommand,
  type EditorCommand,
} from './commandHistory.js'

interface Doc {
  objects: Record<string, { x: number; y: number; z: number }>
  log: string[]
}
const freshDoc = (): Doc => ({
  objects: { a: { x: 0, y: 0, z: 0 }, b: { x: 10, y: 0, z: 0 } },
  log: [],
})
const moveCmd = (id: string, from: [number, number, number], to: [number, number, number]) =>
  snapshotCommand<Doc, [number, number, number]>(`move ${id}`, from, to, (doc, s) => {
    doc.objects[id] = { x: s[0], y: s[1], z: s[2] }
  })

describe('CommandHistory', () => {
  it('execute → undo returns the document to its exact prior state', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    const before = structuredClone(doc)
    h.execute(moveCmd('a', [0, 0, 0], [5, 1, 2]))
    expect(doc.objects['a']).toEqual({ x: 5, y: 1, z: 2 })
    const executed = structuredClone(doc)
    h.undo()
    expect(doc).toEqual(before)
    h.redo()
    expect(doc).toEqual(executed)
  })

  it('a transaction collapses a scrub into ONE entry', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    h.beginTransaction('scale X')
    // 40 frames of a drag — one history entry, not forty.
    for (let i = 1; i <= 40; i++) h.execute(moveCmd('a', [i - 1, 0, 0], [i, 0, 0]))
    h.commitTransaction()
    expect(h.depth).toBe(1)
    expect(doc.objects['a']!.x).toBe(40)
    h.undo()
    expect(doc.objects['a']!.x).toBe(0)
    expect(h.depth).toBe(0)
  })

  it('cancelling a transaction restores state and records nothing', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    const before = structuredClone(doc)
    h.beginTransaction('drag')
    h.execute(moveCmd('a', [0, 0, 0], [3, 0, 0]))
    h.execute(moveCmd('a', [3, 0, 0], [7, 0, 0]))
    h.cancelTransaction()
    expect(doc).toEqual(before)
    expect(h.depth).toBe(0)
  })

  it('composite commands undo their parts in reverse', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    const order: string[] = []
    const mk = (n: string): EditorCommand<Doc> => ({
      label: n,
      execute: () => order.push(`do:${n}`),
      undo: () => order.push(`undo:${n}`),
    })
    h.execute(compositeCommand('group', [mk('1'), mk('2'), mk('3')]))
    h.undo()
    expect(order).toEqual(['do:1', 'do:2', 'do:3', 'undo:3', 'undo:2', 'undo:1'])
  })

  it('20 mixed operations undo to the initial and redo to the final document', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    const initial = structuredClone(doc)
    for (let i = 0; i < 20; i++) {
      const id = i % 2 === 0 ? 'a' : 'b'
      const cur = doc.objects[id]!
      h.execute(moveCmd(id, [cur.x, cur.y, cur.z], [cur.x + i, cur.y + 1, cur.z - i]))
    }
    const final = structuredClone(doc)
    expect(h.depth).toBe(20)
    for (let i = 0; i < 20; i++) h.undo()
    expect(doc).toEqual(initial)
    for (let i = 0; i < 20; i++) h.redo()
    expect(doc).toEqual(final)
  })

  it('a new command clears the redo stack', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    h.execute(moveCmd('a', [0, 0, 0], [1, 0, 0]))
    h.undo()
    expect(h.redoDepth).toBe(1)
    h.execute(moveCmd('b', [10, 0, 0], [11, 0, 0]))
    expect(h.redoDepth).toBe(0)
  })

  it('dirty tracking clears when undoing back to the saved point', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    expect(h.isDirty()).toBe(false)
    h.execute(moveCmd('a', [0, 0, 0], [1, 0, 0]))
    expect(h.isDirty()).toBe(true)
    h.markSaved()
    expect(h.isDirty()).toBe(false)
    h.execute(moveCmd('a', [1, 0, 0], [2, 0, 0]))
    expect(h.isDirty()).toBe(true)
    h.undo()
    expect(h.isDirty()).toBe(false)
  })

  it('undoing past the saved point still reads as dirty', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    h.execute(moveCmd('a', [0, 0, 0], [1, 0, 0]))
    h.markSaved()
    h.undo()
    expect(h.isDirty()).toBe(true)
  })

  it('coalesces successive scrub steps inside a transaction', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    let merged = 0
    const scrub = (to: number): EditorCommand<Doc> => ({
      label: 'scrub',
      execute: (d) => {
        d.objects['a']!.x = to
      },
      undo: (d) => {
        d.objects['a']!.x = 0
      },
      coalesceWith: (n) => (n.label === 'scrub' ? (merged++, true) : false),
    })
    h.beginTransaction('scrub')
    h.execute(scrub(1))
    h.execute(scrub(2))
    h.execute(scrub(3))
    h.commitTransaction()
    expect(merged).toBe(2)
    expect(h.depth).toBe(1)
  })

  it('enforces the entry budget by dropping the oldest', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc, 48 * 1024 * 1024, 5)
    for (let i = 0; i < 12; i++) h.execute(moveCmd('a', [i, 0, 0], [i + 1, 0, 0]))
    expect(h.depth).toBe(5)
  })

  it('enforces the memory budget', () => {
    const doc = freshDoc()
    const big = (): EditorCommand<Doc> => ({
      label: 'paint',
      estimatedBytes: 4 * 1024 * 1024,
      execute: () => {},
      undo: () => {},
    })
    const h = new CommandHistory(doc, 10 * 1024 * 1024, 500)
    for (let i = 0; i < 10; i++) h.execute(big())
    expect(h.depth).toBeLessThanOrEqual(3)
    expect(h.depth).toBeGreaterThan(0)
  })

  it('rebase drops the stack when the document is replaced', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    h.execute(moveCmd('a', [0, 0, 0], [1, 0, 0]))
    h.undo()
    h.rebase()
    expect(h.depth).toBe(0)
    expect(h.redoDepth).toBe(0)
    expect(h.isDirty()).toBe(false)
  })

  it('undo during an open transaction cancels it first', () => {
    const doc = freshDoc()
    const h = new CommandHistory(doc)
    h.execute(moveCmd('a', [0, 0, 0], [1, 0, 0]))
    h.beginTransaction('drag')
    h.execute(moveCmd('a', [1, 0, 0], [9, 0, 0]))
    h.undo()
    // The aborted drag is rolled back AND the earlier command is undone.
    expect(doc.objects['a']!.x).toBe(0)
    expect(h.depth).toBe(0)
  })
})
