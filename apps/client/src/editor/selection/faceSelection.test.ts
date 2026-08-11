import { describe, expect, it } from 'vitest'
import { FaceSelection, faceKey, faceLabel, parseFaceKey } from './faceSelection.js'

describe('face identity', () => {
  it('keys on objectId + face, not on a mesh reference', () => {
    expect(faceKey({ objectId: 'box-1', face: 3 })).toBe('box-1:3')
    expect(faceKey({ objectId: 'terrain:abc', face: null })).toBe('terrain:abc:all')
  })

  it('round-trips keys, including ids that contain colons', () => {
    for (const r of [
      { objectId: 'box-1', face: 0 },
      { objectId: 'terrain:abc', face: null },
      { objectId: 'terrain:a:b', face: 5 },
    ])
      expect(parseFaceKey(faceKey(r))).toEqual(r)
  })

  it('labels box faces by name and other surfaces as whole', () => {
    expect(faceLabel({ objectId: 'x', face: 4 })).toBe('Top')
    expect(faceLabel({ objectId: 'x', face: null })).toBe('whole surface')
  })
})

describe('FaceSelection', () => {
  it('plain click selects exactly one face', () => {
    const s = new FaceSelection()
    s.replace({ objectId: 'a', face: 0 })
    s.replace({ objectId: 'a', face: 1 })
    expect(s.keys()).toEqual(['a:1'])
    expect(s.size).toBe(1)
  })

  it('Ctrl adds a second face and toggles a selected one off', () => {
    const s = new FaceSelection()
    s.replace({ objectId: 'a', face: 0 })
    s.toggle({ objectId: 'a', face: 1 })
    expect(s.size).toBe(2)
    s.toggle({ objectId: 'a', face: 1 })
    expect(s.keys()).toEqual(['a:0'])
  })

  it('accumulates faces across different objects', () => {
    const s = new FaceSelection()
    s.replace({ objectId: 'a', face: 0 })
    s.toggle({ objectId: 'b', face: 2 })
    s.toggle({ objectId: 'terrain:t1', face: null })
    expect(s.size).toBe(3)
    expect(s.refs().map((r) => r.objectId)).toEqual(['a', 'b', 'terrain:t1'])
  })

  it('primary is the first selected face', () => {
    const s = new FaceSelection()
    s.replace({ objectId: 'a', face: 5 })
    s.toggle({ objectId: 'b', face: 1 })
    expect(s.primary()).toEqual({ objectId: 'a', face: 5 })
    s.clear()
    expect(s.primary()).toBeNull()
  })

  it('survives a mesh rebuild — identity is the id, not the mesh', () => {
    const s = new FaceSelection()
    s.replace({ objectId: 'box-1', face: 2 })
    // A material change disposes and recreates the mesh; the key is unchanged.
    expect(s.has({ objectId: 'box-1', face: 2 })).toBe(true)
  })

  it('retain drops faces of deleted objects only', () => {
    const s = new FaceSelection()
    s.replace({ objectId: 'a', face: 0 })
    s.toggle({ objectId: 'gone', face: 1 })
    s.toggle({ objectId: 'b', face: 2 })
    s.retain((id) => id !== 'gone')
    expect(s.keys()).toEqual(['a:0', 'b:2'])
  })

  it('describes the count for the panel', () => {
    const s = new FaceSelection()
    expect(s.describe()).toContain('Ctrl adds')
    s.replace({ objectId: 'a', face: 4 })
    expect(s.describe()).toBe('1 face selected — Top')
    s.toggle({ objectId: 'a', face: 0 })
    expect(s.describe()).toBe('2 faces selected')
  })
})
