import { beforeEach, describe, expect, it } from 'vitest'
import { CommandHistory } from '../history/commandHistory.js'
import { transformFromEuler, type EditorTransform } from './transformMath.js'
import { TransformSession, type TransformAccessor } from './transformSession.js'

const t = (
  p: [number, number, number],
  e: [number, number, number] = [0, 0, 0],
  s: [number, number, number] = [1, 1, 1],
): EditorTransform => transformFromEuler(p, e, s)

interface Doc {
  objects: Map<string, EditorTransform>
}
let doc: Doc
let accessor: TransformAccessor
let history: CommandHistory<Doc>
let session: TransformSession<Doc>

beforeEach(() => {
  doc = {
    objects: new Map<string, EditorTransform>([
      ['a', t([0, 0, 0])],
      ['b', t([10, 0, 0])],
      ['c', t([20, 0, 0])],
      ['terrain:1', t([0, 0, 0], [0, 0, 0], [2, 1, 2])],
    ]),
  }
  accessor = {
    get: (id) => doc.objects.get(id) ?? null,
    set: (id, v) => {
      doc.objects.set(id, v)
    },
  }
  history = new CommandHistory<Doc>(doc)
  session = new TransformSession<Doc>(accessor, history)
})

const snap = (): Record<string, EditorTransform> =>
  Object.fromEntries([...doc.objects].map(([k, v]) => [k, structuredClone(v)]))

describe('TransformSession', () => {
  it('moves every member by the same delta and commits ONE entry', () => {
    const started = session.begin(['a', 'b', 'c'], 'move')
    expect(started).not.toBeNull()
    const p = started!.pivotStart
    session.update({ ...p, position: [p.position[0] + 4, p.position[1], p.position[2]] })
    expect(session.commit()).toBe(true)
    expect(doc.objects.get('a')!.position[0]).toBeCloseTo(4)
    expect(doc.objects.get('b')!.position[0]).toBeCloseTo(14)
    expect(doc.objects.get('c')!.position[0]).toBeCloseTo(24)
    expect(history.depth).toBe(1)
  })

  it('per-frame updates do not compound', () => {
    const started = session.begin(['a', 'b'], 'move')!
    const p = started.pivotStart
    // Ten frames all reporting the SAME pivot pose.
    for (let i = 0; i < 10; i++)
      session.update({ ...p, position: [p.position[0] + 3, p.position[1], p.position[2]] })
    session.commit()
    expect(doc.objects.get('a')!.position[0]).toBeCloseTo(3)
    expect(doc.objects.get('b')!.position[0]).toBeCloseTo(13)
  })

  it('undo restores the exact start state; redo restores the end state', () => {
    const before = snap()
    const started = session.begin(['a', 'b', 'c'], 'move')!
    const p = started.pivotStart
    session.update({ ...p, position: [p.position[0], p.position[1] + 7, p.position[2]] })
    session.commit()
    const after = snap()
    history.undo()
    expect(snap()).toEqual(before)
    history.redo()
    expect(snap()).toEqual(after)
  })

  it('cancel restores start snapshots and records no history', () => {
    const before = snap()
    const started = session.begin(['a', 'b'], 'move')!
    const p = started.pivotStart
    session.update({ ...p, position: [99, 99, 99] })
    expect(doc.objects.get('a')!.position[0]).not.toBeCloseTo(0)
    session.cancel()
    expect(snap()).toEqual(before)
    expect(history.depth).toBe(0)
  })

  it('a gesture that changes nothing records nothing', () => {
    const started = session.begin(['a'], 'move')!
    session.update(started.pivotStart)
    expect(session.commit()).toBe(false)
    expect(history.depth).toBe(0)
  })

  it('mixed terrain + static transforms together, including terrain scale', () => {
    const started = session.begin(['terrain:1', 'b'], 'move')!
    const p = started.pivotStart
    session.update({ ...p, position: [p.position[0], p.position[1] + 5, p.position[2]] })
    session.commit()
    expect(doc.objects.get('terrain:1')!.position[1]).toBeCloseTo(5)
    expect(doc.objects.get('b')!.position[1]).toBeCloseTo(5)
    // The terrain keeps its own scale through a group move.
    expect(doc.objects.get('terrain:1')!.scale).toEqual([2, 1, 2])
  })

  it('scales a mixed group about the pivot (not statics-only)', () => {
    const started = session.begin(['a', 'terrain:1', 'c'], 'scale')!
    const p = started.pivotStart
    session.update({ ...p, scale: [2, 2, 2] })
    session.commit()
    // Every member scales, terrain included.
    expect(doc.objects.get('terrain:1')!.scale[0]).toBeCloseTo(4)
    expect(doc.objects.get('a')!.scale[0]).toBeCloseTo(2)
    expect(doc.objects.get('c')!.scale[0]).toBeCloseTo(2)
  })

  it('refuses to start when a required lock is denied — nothing mutates', () => {
    const before = snap()
    const started = session.begin(['a', 'b'], 'move', { acquireLocks: () => false })
    expect(started).toBeNull()
    expect(session.active).toBe(false)
    expect(history.inTransaction).toBe(false)
    expect(snap()).toEqual(before)
  })

  it('skips read-only members but still transforms the writable ones', () => {
    const started = session.begin(['a', 'b'], 'move', { isWritable: (id) => id !== 'b' })!
    expect(started.ids).toEqual(['a'])
    const p = started.pivotStart
    session.update({ ...p, position: [p.position[0] + 6, p.position[1], p.position[2]] })
    session.commit()
    expect(doc.objects.get('a')!.position[0]).toBeCloseTo(6)
    expect(doc.objects.get('b')!.position[0]).toBeCloseTo(10)
  })

  it('ignores a degenerate pivot instead of writing NaN into the document', () => {
    const started = session.begin(['a'], 'scale')!
    const p = started.pivotStart
    session.update({ ...p, scale: [0, 0, 0] })
    expect(doc.objects.get('a')!.position.every(Number.isFinite)).toBe(true)
    session.update({ ...p, position: [NaN, 0, 0] })
    expect(doc.objects.get('a')!.position.every(Number.isFinite)).toBe(true)
    session.cancel()
  })

  it('cannot begin twice, and returns null for an empty/unknown set', () => {
    expect(session.begin(['nope'], 'move')).toBeNull()
    const s = session.begin(['a'], 'move')
    expect(s).not.toBeNull()
    expect(session.begin(['b'], 'move')).toBeNull()
    session.cancel()
  })

  it('a lost lease mid-drag cancels to the exact start', () => {
    const before = snap()
    const started = session.begin(['a', 'b', 'c'], 'rotate')!
    session.update({ ...started.pivotStart, rotation: [0, 0.7071, 0, 0.7071] })
    // Server says the lease expired.
    session.cancel()
    expect(snap()).toEqual(before)
    expect(history.depth).toBe(0)
  })
})
